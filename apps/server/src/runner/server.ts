import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  DEFAULT_RUNNER_OUTPUT_BYTES, DEFAULT_RUNNER_TURN_MS, MAX_RUNNER_FRAME_BYTES, MAX_RUNNER_REQUEST_BYTES,
  RunnerEvent, RunnerFrame, RunnerRequest, RunnerStatus, type RunnerFrameValue,
} from '../runtime/remote-protocol.js';
import type { AgentRuntime, RuntimeStatus } from '../runtime/types.js';

export interface RunnerServerOptions {
  token: string; createRuntime(): AgentRuntime;
  turnTimeoutMs?: number; maxOutputBytes?: number; cleanupTimeoutMs?: number;
}
function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}
async function requestBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const data of request) {
    size += data.length;
    if (size > MAX_RUNNER_REQUEST_BYTES) throw new Error('Request too large.');
    chunks.push(data);
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
}
async function bounded(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise.then(() => true, () => false), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), ms); })]); }
  finally { clearTimeout(timer); }
}

/** Internal-only, one active owner. A broken stream is never resumed or replayed. */
export function createRunnerServer(options: RunnerServerOptions) {
  if (options.token.length < 32 || options.token.length > 8192 || /\s/.test(options.token)) throw new Error('Invalid runner token.');
  const expected = createHash('sha256').update(options.token).digest();
  let runtime: AgentRuntime | null = null;
  let active: { abort(): void; done: Promise<void> } | null = null;
  let stopped = false;
  let quarantined = false;
  let statusOperation: Promise<unknown> | null = null;
  let lastStatus: RuntimeStatus = { provider: 'codex-runner', available: false, authenticated: null, message: '执行器尚未检查授权状态。', models: [] };
  const getRuntime = () => runtime ??= options.createRuntime();
  const authorized = (request: IncomingMessage) => {
    const token = request.headers.authorization;
    return typeof token === 'string' && token.startsWith('Bearer ') && token.length <= 8200
      && timingSafeEqual(expected, createHash('sha256').update(token.slice(7)).digest());
  };
  const server = createServer({ maxHeaderSize: 12 * 1024 }, (request, response) => {
    void handle(request, response).catch(() => { if (!response.headersSent) json(response, 500, { error: 'runner_error' }); else response.destroy(); });
  });
  server.headersTimeout = 10_000; server.requestTimeout = 15_000; server.keepAliveTimeout = 5_000;
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method === 'GET' && request.url === '/health') {
      json(response, quarantined || stopped ? 503 : 200, { ok: !quarantined && !stopped, protocolVersion: 1 }); return;
    }
    if (!authorized(request)) { json(response, 401, { error: 'unauthorized' }); return; }
    if (stopped || quarantined) { json(response, 503, { error: 'runner_unavailable' }); return; }
    if (request.method === 'GET' && request.url === '/v1/status') {
      // Never create a replacement provider while an aborted owner's cleanup is
      // still in flight. Status is informational; explicit run owns readiness.
      if (active) { json(response, 200, lastStatus); return; }
      if (!statusOperation) {
        statusOperation = getRuntime().getStatus().then(value => { lastStatus = RunnerStatus.parse(value); return lastStatus; });
        void statusOperation.finally(() => { statusOperation = null; }).catch(() => {});
      }
      const operation = statusOperation;
      if (!await bounded(operation, 20_000)) { json(response, 503, { error: 'status_unavailable' }); return; }
      const status = await operation;
      const body = JSON.stringify(status);
      if (Buffer.byteLength(body) > MAX_RUNNER_FRAME_BYTES) throw new Error('Status limit.');
      json(response, 200, status); return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/run') { json(response, 404, { error: 'not_found' }); return; }
    if (active) { json(response, 409, { error: 'runner_busy' }); return; }
    if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') { json(response, 415, { error: 'invalid_content_type' }); return; }
    let payload;
    try { payload = RunnerRequest.parse(await requestBody(request)); }
    catch { if (!response.destroyed) json(response, 400, { error: 'invalid_request' }); return; }
    // Parsing is asynchronous: another request may have taken ownership meanwhile.
    if (active || stopped || quarantined) { json(response, 409, { error: 'runner_busy' }); return; }
    if (response.destroyed) return;
    const current = getRuntime();
    const controller = new AbortController();
    let finishOwner!: () => void;
    const ownerDone = new Promise<void>(resolve => { finishOwner = resolve; });
    active = { abort: () => controller.abort(), done: ownerDone };
    let sequence = 0, outputBytes = 0, buffered = 0;
    let writes = Promise.resolve();
    let acceptsEvents = true;
    let threadPrepared = false;
    const abort = () => controller.abort();
    const closed = () => { if (!response.writableEnded) abort(); };
    response.once('close', closed);
    const timeout = setTimeout(abort, options.turnTimeoutMs ?? DEFAULT_RUNNER_TURN_MS);
    const aborted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(new Error('Execution interrupted.')), { once: true });
    });
    void aborted.catch(() => {});
    const enqueue = (frame: RunnerFrameValue) => {
      RunnerFrame.parse(frame);
      const line = `${JSON.stringify(frame)}\n`, bytes = Buffer.byteLength(line);
      outputBytes += bytes; buffered += bytes;
      // Reserve space for the terminal frame within the client's total budget.
      if (bytes > MAX_RUNNER_FRAME_BYTES || outputBytes > (options.maxOutputBytes ?? DEFAULT_RUNNER_OUTPUT_BYTES) - 4096 || buffered > 256 * 1024) {
        abort(); throw new Error('Output limit.');
      }
      writes = writes.then(() => new Promise<void>((resolve, reject) => {
        if (response.destroyed || controller.signal.aborted) { reject(new Error('Stream closed.')); return; }
        response.write(line, error => { buffered -= bytes; if (error) reject(error); else resolve(); });
      }));
      void writes.catch(abort);
    };
    let run: Promise<void> = Promise.resolve();
    let terminal: 'completed' | 'failed' | 'waiting_for_input' | 'interrupted' = 'completed';
    let message: string | undefined;
    try {
      response.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      enqueue({ type: 'accepted', runId: payload.runId, seq: 0 });
      await Promise.race([writes, aborted]);
      if (statusOperation) await Promise.race([statusOperation, aborted]);
      run = Promise.resolve().then(() => current.run(payload.input, event => {
        if (!acceptsEvents || controller.signal.aborted) return;
        try {
          const validated = RunnerEvent.parse(event);
          if (validated.type === 'thread_started') threadPrepared = true;
          enqueue({ type: 'event', runId: payload.runId, seq: ++sequence, event: validated });
        }
        catch { abort(); }
      }, controller.signal));
      void run.catch(() => {});
      await Promise.race([run, aborted]);
      await Promise.race([writes, aborted]);
    } catch (error) {
      terminal = controller.signal.aborted || (error instanceof Error && (error.name === 'RuntimeInterruptedError'
        || (threadPrepared && error.name === 'RuntimeUnavailableError'))) ? 'interrupted'
        : error instanceof Error && ['RuntimeUnavailableError', 'RuntimeInputRequiredError'].includes(error.name) ? 'waiting_for_input' : 'failed';
      message = terminal === 'waiting_for_input' ? '执行器需要完成授权或检查运行配置。'
        : terminal === 'interrupted' ? '执行器已中断，请核对已有结果后重试。' : '执行器未能完成本次任务。';
    } finally {
      acceptsEvents = false; clearTimeout(timeout);
      // Any unsuccessful run closes its provider before a new owner is admitted.
      if (terminal !== 'completed') {
        controller.abort();
        runtime = null;
        const cleaned = await bounded(Promise.all([Promise.resolve().then(() => current.close()), run.catch(() => {})]), options.cleanupTimeoutMs ?? 30_000);
        if (!cleaned) quarantined = true;
      }
      try {
        if (!await bounded(writes, 1000)) throw new Error('Stream did not drain.');
        if (!response.destroyed) {
          const frame = RunnerFrame.parse({ type: 'terminal', runId: payload.runId, seq: ++sequence, status: terminal, ...(message ? { message } : {}) });
          response.end(`${JSON.stringify(frame)}\n`);
        }
      } catch { response.destroy(); }
      response.removeListener('close', closed);
      active = null; finishOwner();
    }
  }
  return {
    server,
    async close(): Promise<void> {
      stopped = true;
      const owner = active; owner?.abort();
      server.close();
      if (owner) await owner.done;
      if (runtime) { const current = runtime; runtime = null; await bounded(current.close(), options.cleanupTimeoutMs ?? 30_000); }
      server.closeAllConnections();
    },
  };
}
