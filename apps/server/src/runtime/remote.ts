import { randomUUID } from 'node:crypto';
import {
  DEFAULT_RUNNER_OUTPUT_BYTES, DEFAULT_RUNNER_TURN_MS, MAX_RUNNER_FRAME_BYTES,
  RunnerFrameDecoder, RunnerInput, RunnerStatus,
} from './remote-protocol.js';
import {
  RuntimeCancelledError, RuntimeInputRequiredError, RuntimeInterruptedError, RuntimeUnavailableError,
  type AgentRuntime, type RuntimeEvent, type RuntimeInput, type RuntimeStatus,
} from './types.js';

export interface RemoteRuntimeOptions {
  url: string; token: string; turnTimeoutMs?: number; maxOutputBytes?: number;
  fetch?: typeof fetch;
}
class RemoteExecutionError extends Error {}
export function normalizeRunnerUrl(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Runner URL must be an HTTP(S) root without credentials or parameters.');
  }
  return url.origin;
}
/** One HTTP request owns one execution. Never retry a POST or a truncated stream. */
export class RemoteRuntime implements AgentRuntime {
  private readonly url: string;
  private readonly transport: typeof fetch;
  private active: AbortController | null = null;
  private closed = false;
  constructor(private options: RemoteRuntimeOptions) {
    this.url = normalizeRunnerUrl(options.url);
    if (options.token.length < 32 || options.token.length > 8192 || /\s/.test(options.token)) throw new Error('Invalid runner token.');
    this.transport = options.fetch ?? fetch;
  }
  private headers() { return { authorization: `Bearer ${this.options.token}`, accept: 'application/json' }; }
  async getStatus(): Promise<RuntimeStatus> {
    if (this.closed) return { provider: 'remote', available: false, authenticated: null, message: '执行器连接已关闭。', models: [] };
    try {
      const response = await this.transport(`${this.url}/v1/status`, {
        headers: this.headers(), redirect: 'error', signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(); }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > MAX_RUNNER_FRAME_BYTES) throw new Error(); chunks.push(part.value); }
        return RunnerStatus.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    } catch {
      return { provider: 'remote', available: false, authenticated: null, message: '暂时无法连接私有执行器，请检查部署连接。', models: [] };
    }
  }
  async run(input: RuntimeInput, sink: (event: RuntimeEvent) => void, signal: AbortSignal): Promise<void> {
    if (this.closed || this.active) throw new RuntimeUnavailableError('执行器连接未就绪或正在处理任务。');
    if (signal.aborted) throw new RuntimeCancelledError();
    const controller = new AbortController();
    this.active = controller;
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, this.options.turnTimeoutMs ?? DEFAULT_RUNNER_TURN_MS);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      // Codex persists its own thread history. Do not transmit the optional,
      // duplicated application history or any caller-defined extra properties.
      const payload = RunnerInput.parse({
        taskId: input.taskId, conversationId: input.conversationId, text: input.text,
        effort: input.effort, threadId: input.threadId,
      });
      const runId = randomUUID();
      const response = await this.transport(`${this.url}/v1/run`, {
        method: 'POST', redirect: 'error', headers: { ...this.headers(), 'content-type': 'application/json', accept: 'application/x-ndjson' },
        body: JSON.stringify({ protocolVersion: 1, runId, input: payload }), signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        if ([401, 403, 409, 503].includes(response.status)) throw new RuntimeUnavailableError('私有执行器拒绝了任务，请检查独立密钥或稍后重试。');
        throw new RuntimeInterruptedError('执行器未确认受理结果，请核对任务后再重试。');
      }
      if (!response.headers.get('content-type')?.startsWith('application/x-ndjson')) throw new Error('Invalid stream type.');
      reader = response.body.getReader();
      const decoder = new RunnerFrameDecoder(this.options.maxOutputBytes ?? DEFAULT_RUNNER_OUTPUT_BYTES);
      let sequence = -1;
      let terminal: { status: string; message?: string } | null = null;
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        for (const frame of decoder.push(part.value)) {
          if (terminal || frame.runId !== runId || frame.seq !== sequence + 1 || (sequence < 0 && frame.type !== 'accepted')
            || (sequence >= 0 && frame.type === 'accepted')) throw new Error('Unexpected runner event ownership.');
          sequence = frame.seq;
          if (frame.type === 'event') {
            if (signal.aborted || controller.signal.aborted) throw new Error('Aborted execution.');
            sink(frame.event);
          } else if (frame.type === 'terminal') terminal = frame;
        }
      }
      decoder.finish();
      if (!terminal) throw new Error('Runner disconnected without a terminal event.');
      if (signal.aborted) throw new RuntimeCancelledError();
      if (controller.signal.aborted) throw new Error('Execution deadline exceeded.');
      if (terminal.status === 'waiting_for_input') throw new RuntimeInputRequiredError(terminal.message ?? '执行器需要你处理连接或授权。');
      if (terminal.status === 'interrupted') throw new RuntimeInterruptedError(terminal.message ?? '执行器中断，请核对已有结果。');
      if (terminal.status === 'failed') throw new RemoteExecutionError(terminal.message ?? '执行器未能完成任务。');
    } catch (error) {
      if (signal.aborted) throw new RuntimeCancelledError();
      if (error instanceof RuntimeUnavailableError || error instanceof RuntimeInputRequiredError || error instanceof RuntimeInterruptedError || error instanceof RemoteExecutionError) throw error;
      throw new RuntimeInterruptedError('执行器连接中断或输出不完整。已停止接收，不会自动重放任务。');
    } finally {
      controller.abort(); // Closing the stream cancels runner ownership as well.
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
      clearTimeout(timer); signal.removeEventListener('abort', abort); this.active = null;
    }
  }
  async close(): Promise<void> { this.closed = true; this.active?.abort(); }
}
