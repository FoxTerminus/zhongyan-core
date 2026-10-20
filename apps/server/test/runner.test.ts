import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { it } from 'node:test';
import { createRunnerServer, type RunnerServerOptions } from '../src/runner/server.js';
import { loadRunnerConfig } from '../src/runner/config.js';
import { RemoteRuntime } from '../src/runtime/remote.js';
import { RuntimeInputRequiredError, RuntimeUnavailableError, type AgentRuntime, type RuntimeEvent, type RuntimeInput } from '../src/runtime/types.js';
import { loadConfig } from '../src/config.js';

const token = 'runner-only-'.repeat(4);
const input: RuntimeInput = { taskId: 'task', conversationId: 'conversation', text: '测试', effort: 'low', threadId: null };
const status = { provider: 'test-only', available: true, authenticated: true, message: '', models: [] };
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const body = () => JSON.stringify({ protocolVersion: 1, runId: randomUUID(), input });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!check()) { assert.ok(Date.now() < deadline, 'condition must settle'); await delay(5); }
}
function runtime(run: AgentRuntime['run'] = async (_input, sink) => { sink({ type: 'message_delta', data: { text: '测试输出' } }); }): AgentRuntime {
  return { getStatus: async () => status, run, close: async () => {} };
}
async function fixture(options: Partial<RunnerServerOptions> = {}) {
  const instance = createRunnerServer({ token, createRuntime: () => runtime(), ...options });
  instance.server.listen(0, '127.0.0.1');
  await once(instance.server, 'listening');
  return { ...instance, url: `http://127.0.0.1:${(instance.server.address() as AddressInfo).port}` };
}

it('requires a separate bearer for status/run and exposes only liveness without credentials', async () => {
  let statusCalls = 0;
  const server = await fixture({ createRuntime: () => ({ ...runtime(), getStatus: async () => { statusCalls++; return status; } }) });
  try {
    assert.deepEqual(await (await fetch(`${server.url}/health`)).json(), { ok: true, protocolVersion: 1 });
    assert.equal(statusCalls, 0);
    assert.equal((await fetch(`${server.url}/v1/status`)).status, 401);
    assert.equal((await fetch(`${server.url}/v1/run`, { method: 'POST', headers: { ...headers, authorization: 'Bearer wrong' }, body: body() })).status, 401);
    assert.deepEqual(await (await fetch(`${server.url}/v1/status`, { headers })).json(), status);
    assert.equal(statusCalls, 1);
    assert.equal((await fetch(`${server.url}/app-server`, { headers })).status, 404);
  } finally { await server.close(); }
});

it('validates narrow task input and delivers completed events over the real HTTP adapter', async () => {
  let executions = 0;
  const server = await fixture({ createRuntime: () => runtime(async (received, sink) => {
    executions++; assert.deepEqual(received, input);
    sink({ type: 'thread_started', data: { threadId: 'thread-1' } });
    sink({ type: 'message_delta', data: { text: '雾紫白龙' } });
  }) });
  const adapter = new RemoteRuntime({ url: server.url, token });
  try {
    const invalid = JSON.parse(body()); invalid.input.command = 'do not expose commands';
    assert.equal((await fetch(`${server.url}/v1/run`, { method: 'POST', headers, body: JSON.stringify(invalid) })).status, 400);
    const events: RuntimeEvent[] = [];
    await adapter.run({ ...input, history: [{ role: 'user', text: 'not transmitted' }] }, event => events.push(event), new AbortController().signal);
    assert.equal(executions, 1);
    assert.deepEqual(events.map(event => event.type), ['thread_started', 'message_delta']);
    assert.equal((await fetch(`${server.url}/health`)).status, 200);
  } finally { await adapter.close(); await server.close(); }
});

it('holds single ownership through cancellation cleanup, then admits a fresh provider', async () => {
  const began = deferred(), cleanup = deferred();
  let creations = 0, closed = false;
  const server = await fixture({ createRuntime: () => {
    creations++;
    if (creations > 1) return runtime();
    return {
      getStatus: async () => status,
      run: async (_input, _sink, signal) => {
        began.resolve();
        await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      },
      close: async () => { closed = true; await cleanup.promise; },
    };
  } });
  const adapter = new RemoteRuntime({ url: server.url, token });
  const controller = new AbortController();
  const first = adapter.run(input, () => {}, controller.signal);
  const cancelled = assert.rejects(first, { name: 'RuntimeCancelledError' });
  try {
    await began.promise;
    assert.equal((await fetch(`${server.url}/v1/run`, { method: 'POST', headers, body: body() })).status, 409);
    controller.abort(); await cancelled; await until(() => closed);
    assert.equal((await fetch(`${server.url}/v1/run`, { method: 'POST', headers, body: body() })).status, 409);
    await fetch(`${server.url}/v1/status`, { headers });
    assert.equal(creations, 1, 'status cannot create another provider during cleanup');
    cleanup.resolve();
    await delay(30);
    await adapter.run(input, () => {}, new AbortController().signal);
    assert.equal(creations, 2);
  } finally { cleanup.resolve(); controller.abort(); await adapter.close(); await server.close(); }
});

it('quarantines an uncooperative provider after its cleanup deadline', async () => {
  const began = deferred(), release = deferred();
  let closeCalls = 0;
  const server = await fixture({ cleanupTimeoutMs: 30, createRuntime: () => ({
    getStatus: async () => status,
    run: async () => { began.resolve(); await release.promise; },
    close: async () => { closeCalls++; await release.promise; },
  }) });
  const controller = new AbortController();
  try {
    const response = await fetch(`${server.url}/v1/run`, { method: 'POST', headers, body: body(), signal: controller.signal });
    await began.promise;
    controller.abort(); await response.body?.cancel().catch(() => {});
    await until(() => closeCalls > 0);
    await delay(60);
    assert.equal((await fetch(`${server.url}/health`)).status, 503);
    assert.equal((await fetch(`${server.url}/v1/run`, { method: 'POST', headers, body: body() })).status, 503);
  } finally { release.resolve(); await server.close(); }
});

it('ends a running stream on runner shutdown without silently replaying it', async () => {
  const began = deferred();
  let runs = 0, closeCalls = 0;
  const server = await fixture({ createRuntime: () => ({
    getStatus: async () => status,
    run: async (_input, sink, signal) => {
      runs++; sink({ type: 'message_delta', data: { text: '保留部分输出' } }); began.resolve();
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    },
    close: async () => { closeCalls++; },
  }) });
  const adapter = new RemoteRuntime({ url: server.url, token });
  const events: RuntimeEvent[] = [];
  const run = assert.rejects(adapter.run(input, event => events.push(event), new AbortController().signal), { name: 'RuntimeInterruptedError' });
  await began.promise; await server.close(); await run; await adapter.close();
  assert.equal(runs, 1); assert.equal(closeCalls, 1); assert.equal(events.length, 1);
});

it('bounds turn duration and cancels its provider on timeout', async () => {
  let aborted = false, closed = false;
  const server = await fixture({ turnTimeoutMs: 40, createRuntime: () => ({
    getStatus: async () => status,
    run: async (_input, _sink, signal) => {
      await new Promise<void>(resolve => signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
    },
    close: async () => { closed = true; },
  }) });
  const adapter = new RemoteRuntime({ url: server.url, token });
  try {
    await assert.rejects(adapter.run(input, () => {}, new AbortController().signal), { name: 'RuntimeInterruptedError' });
    assert.equal(aborted, true); assert.equal(closed, true);
  } finally { await adapter.close(); await server.close(); }
});

it('keeps authorization-required and actual failure distinct from transport interruption', async () => {
  for (const [failure, expected] of [[new RuntimeInputRequiredError('login'), 'RuntimeInputRequiredError'], [new Error('private internal error'), 'Error']] as const) {
    const server = await fixture({ createRuntime: () => runtime(async () => { throw failure; }) });
    const adapter = new RemoteRuntime({ url: server.url, token });
    try { await assert.rejects(adapter.run(input, () => {}, new AbortController().signal), error => error instanceof Error && error.name === expected && !error.message.includes('private internal error')); }
    finally { await adapter.close(); await server.close(); }
  }
});

it('rejects invalid output and closes the provider instead of reporting completion', async () => {
  let closed = false;
  const server = await fixture({ createRuntime: () => ({
    ...runtime(async (_input, sink) => { sink({ type: 'message_delta', data: { text: 'a'.repeat(16001) } }); }),
    close: async () => { closed = true; },
  }) });
  const adapter = new RemoteRuntime({ url: server.url, token });
  try { await assert.rejects(adapter.run(input, () => {}, new AbortController().signal), { name: 'RuntimeInterruptedError' }); assert.equal(closed, true); }
  finally { await adapter.close(); await server.close(); }
});

it('marks provider disconnection after thread preparation interrupted instead of requesting authorization', async () => {
  const server = await fixture({ createRuntime: () => runtime(async (_input, sink) => {
    sink({ type: 'thread_started', data: { threadId: 'ready-thread' } });
    throw new RuntimeUnavailableError('provider exited during turn/start');
  }) });
  const client = new RemoteRuntime({ url: server.url, token });
  try { await assert.rejects(client.run(input, () => {}, new AbortController().signal), { name: 'RuntimeInterruptedError' }); }
  finally { await client.close(); await server.close(); }
});

it('requires separated credentials/directories and rejects remote tools or URL credentials', () => {
  const env = { AGENT_RUNTIME: 'remote', AGENT_AUTH_TOKEN: 'device-'.repeat(6), AGENT_RUNNER_URL: 'http://runner:8788', AGENT_RUNNER_AUTH_TOKEN: token };
  assert.equal(loadConfig(env).runtime, 'remote');
  assert.throws(() => loadConfig({ ...env, AGENT_RUNNER_AUTH_TOKEN: env.AGENT_AUTH_TOKEN }));
  assert.throws(() => loadConfig({ ...env, AGENT_CODEX_KNOWLEDGE_TOOLS: 'experimental' }));
  assert.throws(() => loadConfig({ ...env, AGENT_RUNNER_URL: 'https://user:password@example.com' }));
  const runnerEnv = { AGENT_RUNNER_AUTH_TOKEN: token, AGENT_CHATGPT_PROFILE_DIR: '/state/profile', AGENT_RUNNER_WORKSPACE: '/workspace' };
  assert.equal(loadRunnerConfig(runnerEnv).port, 8788);
  assert.equal(loadRunnerConfig({ ...runnerEnv, AGENT_CODEX_MODEL: '' }).model, undefined);
  assert.throws(() => loadRunnerConfig({ ...runnerEnv, AGENT_AUTH_TOKEN: 'device' }));
  assert.throws(() => loadRunnerConfig({ ...runnerEnv, AGENT_RUNNER_WORKSPACE: '/state/profile/inside' }));
});
