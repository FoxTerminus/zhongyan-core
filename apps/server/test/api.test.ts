import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { Store } from '../src/store.js';
import {
  RuntimeInputRequiredError, RuntimeUnavailableError,
  type AgentRuntime, type RuntimeEvent, type RuntimeInput, type RuntimeStatus,
} from '../src/runtime/types.js';

const AUTH_TOKEN = 'test-only-token-0123456789abcdef0123456789abcdef';
const headers = { authorization: `Bearer ${AUTH_TOKEN}` };
const testRoot = fileURLToPath(new URL('../../../work/api-tests/', import.meta.url));

type Turn = {
  input: RuntimeInput;
  emit: (event: RuntimeEvent) => void;
  signal: AbortSignal;
  complete: () => void;
  fail: (error: Error) => void;
};

/** This runtime is confined to tests and makes no external model calls. */
class ControlledRuntime implements AgentRuntime {
  status: RuntimeStatus = {
    provider: 'test-double', available: true, authenticated: true,
    message: '测试执行器可用', models: [{ id: 'test-model', displayName: 'Test model' }],
  };
  turns: Turn[] = [];
  statusCalls = 0;
  statusFailure?: Error;
  settleOnAbort = true;
  closed = false;

  async getStatus() {
    this.statusCalls++;
    if (this.statusFailure) throw this.statusFailure;
    return this.status;
  }

  async run(input: RuntimeInput, emit: Turn['emit'], signal: AbortSignal) {
    // Like production adapters, this double owns readiness at execution time.
    if (!this.status.available || this.status.authenticated === false) throw new RuntimeUnavailableError(this.status.message);
    let complete!: () => void;
    let fail!: (error: Error) => void;
    const done = new Promise<void>((resolvePromise, rejectPromise) => {
      complete = resolvePromise;
      fail = rejectPromise;
    });
    const abort = () => { if (this.settleOnAbort) complete(); };
    signal.addEventListener('abort', abort, { once: true });
    this.turns.push({ input, emit, signal, complete, fail });
    try { await done; }
    finally { signal.removeEventListener('abort', abort); }
  }

  releaseAll() { for (const turn of this.turns) turn.complete(); }
  async close() { this.closed = true; this.releaseAll(); }
}

type Fixture = {
  app: ReturnType<typeof createApp>;
  store: Store;
  runtime: ControlledRuntime;
  directory: string;
  databasePath: string;
  closed: boolean;
};

async function until(predicate: () => boolean, explanation: string) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `Timed out: ${explanation}`);
    await new Promise(resolvePromise => setTimeout(resolvePromise, 5));
  }
}
const nextLoop = () => new Promise<void>(resolvePromise => setImmediate(resolvePromise));

describe('HTTP API and durable worker', { concurrency: false }, () => {
  const fixtures: Fixture[] = [];

  async function fixture(options: { startWorker?: boolean; runtime?: ControlledRuntime; prepare?: (store: Store) => void } = {}) {
    mkdirSync(testRoot, { recursive: true });
    const directory = mkdtempSync(join(testRoot, 'api-'));
    const databasePath = join(directory, 'state.sqlite');
    const store = new Store(databasePath);
    const runtime = options.runtime ?? new ControlledRuntime();
    options.prepare?.(store);
    const app = createApp({ store, runtime, authToken: AUTH_TOKEN, startWorker: options.startWorker });
    const instance = { app, store, runtime, directory, databasePath, closed: false };
    fixtures.push(instance);
    await app.ready();
    return instance;
  }

  async function conversation(instance: Fixture) {
    const response = await instance.app.inject({ method: 'POST', url: '/v1/conversations', headers, payload: {} });
    assert.equal(response.statusCode, 200);
    return response.json().conversation as { id: string };
  }

  async function send(instance: Fixture, conversationId: string, text: string, requestId = randomUUID()) {
    const response = await instance.app.inject({
      method: 'POST', url: `/v1/conversations/${conversationId}/messages`, headers,
      payload: { text, clientRequestId: requestId, effort: 'medium' },
    });
    assert.equal(response.statusCode, 202, response.body);
    return response.json() as { task: { id: string; status: string }; message: { id: string; text: string } };
  }

  afterEach(async () => {
    for (const instance of fixtures.splice(0)) {
      // Even a failed assertion must release a deliberately uncooperative turn
      // before closing the worker, so test cleanup cannot hang.
      instance.runtime.settleOnAbort = true;
      instance.runtime.releaseAll();
      if (!instance.closed) await instance.app.close();
      const safeRoot = realpathSync(testRoot);
      const target = realpathSync(resolve(instance.directory));
      const descendant = relative(safeRoot, target);
      assert.ok(descendant && !isAbsolute(descendant)
        && descendant !== '..' && !descendant.startsWith(`..${sep}`),
      'Test cleanup target must remain beneath project/work/api-tests');
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('allows health checks but authenticates private data and errors before dispatch', async () => {
    const instance = await fixture({ startWorker: false });
    const privateConversation = instance.store.createConversation('PRIVATE-CONVERSATION-MARKER');
    const publicHealth = await instance.app.inject({ method: 'GET', url: '/health' });
    assert.equal(publicHealth.statusCode, 200);
    assert.deepEqual(publicHealth.json(), { status: 'ok', protocolVersion: 1 });
    for (const authorization of [undefined, 'Bearer incorrect-secret', `Basic ${AUTH_TOKEN}`, `Bearer ${'x'.repeat(2050)}`]) {
      for (const url of ['/v1/status', '/v1/conversations', `/v1/conversations/${privateConversation.id}`, '/v1/tasks/not-a-uuid/events']) {
        const response = await instance.app.inject({ method: 'GET', url, headers: authorization ? { authorization } : {} });
        assert.equal(response.statusCode, 401);
        assert.equal(response.json().error.code, 'unauthorized');
        assert.equal(response.headers['cache-control'], 'no-store');
        assert.ok(!response.body.includes(AUTH_TOKEN));
        assert.ok(!response.body.includes('PRIVATE-CONVERSATION-MARKER'));
        assert.ok(!response.body.includes('incorrect-secret'));
      }
    }
    assert.equal(instance.runtime.statusCalls, 0);
    const permitted = await instance.app.inject({ method: 'GET', url: '/v1/conversations', headers });
    assert.equal(permitted.statusCode, 200);
    assert.equal(permitted.json().conversations[0].id, privateConversation.id);
  });

  it('does not disclose runtime exceptions from the status endpoint', async () => {
    const runtime = new ControlledRuntime();
    runtime.statusFailure = new Error('INTERNAL-SECRET-PATH-AND-TOKEN');
    const { app } = await fixture({ startWorker: false, runtime });
    const response = await app.inject({ method: 'GET', url: '/v1/status', headers });
    assert.equal(response.statusCode, 500);
    assert.equal(response.json().error.code, 'internal_error');
    assert.ok(!response.body.includes('INTERNAL-SECRET-PATH-AND-TOKEN'));
    assert.ok(!response.body.includes('stack'));
  });

  it('rejects invalid identifiers, text, effort, request keys and event cursors without enqueueing', async () => {
    const instance = await fixture({ startWorker: false });
    const conv = await conversation(instance);
    for (const payload of [
      { text: '   ', clientRequestId: randomUUID() },
      { text: 'x'.repeat(32001), clientRequestId: randomUUID() },
      { text: 'hello', clientRequestId: 'invalid' },
      { text: 'hello', clientRequestId: randomUUID(), effort: 'unlimited' },
      { text: 'hello', clientRequestId: randomUUID(), unexpected: true },
    ]) {
      const response = await instance.app.inject({ method: 'POST', url: `/v1/conversations/${conv.id}/messages`, headers, payload });
      assert.equal(response.statusCode, 400);
      assert.equal(response.json().error.code, 'invalid_input');
    }
    for (const url of ['/v1/conversations/invalid', `/v1/tasks/${randomUUID()}/events?after=-1`, `/v1/tasks/${randomUUID()}/events?after=1.5`, `/v1/tasks/${randomUUID()}/events?after=NaN`]) {
      assert.equal((await instance.app.inject({ method: 'GET', url, headers })).statusCode, 400);
    }
    assert.equal(instance.store.snapshot(conv.id).tasks.length, 0);
    assert.equal(instance.store.messages(conv.id).length, 0);
    const missing = await instance.app.inject({ method: 'GET', url: `/v1/conversations/${randomUUID()}`, headers });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().error.code, 'not_found');
  });

  it('returns client errors for malformed JSON and oversized bodies', async () => {
    const { app } = await fixture({ startWorker: false });
    const malformed = await app.inject({
      method: 'POST', url: '/v1/conversations', headers: { ...headers, 'content-type': 'application/json' }, payload: '{',
    });
    assert.equal(malformed.statusCode, 400);
    const oversized = await app.inject({ method: 'POST', url: '/v1/conversations', headers, payload: { title: 'x'.repeat(270 * 1024) } });
    assert.equal(oversized.statusCode, 413);
    assert.equal(oversized.json().error.code, 'too_large');
  });

  it('keeps repeated HTTP sends idempotent and returns 409 on conflicting content', async () => {
    const instance = await fixture({ startWorker: false });
    const conv = await conversation(instance);
    const requestId = randomUUID();
    const original = await send(instance, conv.id, '唯一消息', requestId);
    const duplicate = await send(instance, conv.id, '唯一消息', requestId);
    assert.equal(duplicate.task.id, original.task.id);
    assert.equal(duplicate.message.id, original.message.id);
    const conflict = await instance.app.inject({
      method: 'POST', url: `/v1/conversations/${conv.id}/messages`, headers,
      payload: { text: '不同内容', clientRequestId: requestId, effort: 'medium' },
    });
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json().error.code, 'idempotency_conflict');
    assert.equal(instance.store.snapshot(conv.id).tasks.length, 1);
    assert.equal(instance.store.messages(conv.id).length, 1);
    const events = await instance.app.inject({ method: 'GET', url: `/v1/tasks/${original.task.id}/events?after=0`, headers });
    assert.equal(events.statusCode, 200);
    const cursor = events.json().nextCursor;
    const replay = await instance.app.inject({ method: 'GET', url: `/v1/tasks/${original.task.id}/events?after=${cursor}`, headers });
    assert.deepEqual(replay.json(), { events: [], nextCursor: cursor });
  });

  it('waits for user input when the runtime is unavailable and resumes only on explicit retry', async () => {
    const runtime = new ControlledRuntime();
    runtime.status = { ...runtime.status, available: false, authenticated: false, message: '请连接模型账户' };
    const instance = await fixture({ runtime });
    const conv = await conversation(instance);
    const { task } = await send(instance, conv.id, '需要模型');
    await until(() => instance.store.getTask(task.id).status === 'waiting_for_input', 'unavailable runtime pauses task');
    assert.equal(runtime.turns.length, 0);
    assert.equal(instance.store.getTask(task.id).error, '请连接模型账户');
    runtime.status = { ...runtime.status, available: true, authenticated: true, message: '已连接' };
    await nextLoop();
    assert.equal(instance.store.getTask(task.id).status, 'waiting_for_input');
    const retry = await instance.app.inject({ method: 'POST', url: `/v1/tasks/${task.id}/retry`, headers });
    assert.equal(retry.statusCode, 200);
    await until(() => runtime.turns.length === 1, 'explicit retry starts runtime');
    runtime.turns[0]!.emit({ type: 'message_delta', data: { text: '连接成功后的结果' } });
    runtime.turns[0]!.complete();
    await until(() => instance.store.getTask(task.id).status === 'completed', 'retried task completes');
    assert.equal(instance.store.messages(conv.id).filter(message => message.role === 'user').length, 1);
  });

  it('persists streamed output, activity and external thread state before completion', async () => {
    const instance = await fixture();
    const conv = await conversation(instance);
    const { task } = await send(instance, conv.id, '请给出结果');
    await until(() => instance.runtime.turns.length === 1, 'runtime starts');
    const turn = instance.runtime.turns[0]!;
    assert.equal(turn.input.taskId, task.id);
    assert.equal(turn.input.text, '请给出结果');
    assert.equal(turn.input.effort, 'medium');
    turn.emit({ type: 'thread_started', data: { threadId: 'external-thread' } });
    turn.emit({ type: 'activity', data: { message: '正在处理' } });
    turn.emit({ type: 'message_delta', data: { text: '第一部分' } });
    turn.emit({ type: 'message_delta', data: { text: '与第二部分' } });
    assert.equal(instance.store.getTask(task.id).status, 'running');
    assert.equal(instance.store.messages(conv.id).find(message => message.role === 'assistant')?.text, '第一部分与第二部分');
    assert.equal(instance.store.threadId(conv.id), 'external-thread');
    assert.ok(instance.store.events(task.id, 0).events.some(event => event.type === 'activity'));
    turn.complete();
    await until(() => instance.store.getTask(task.id).status === 'completed', 'output completes');
    const snapshot = await instance.app.inject({ method: 'GET', url: `/v1/conversations/${conv.id}`, headers });
    assert.equal(snapshot.json().tasks[0].status, 'completed');
    assert.equal(snapshot.json().messages[1].text, '第一部分与第二部分');
    const eventsAfterCompletion = instance.store.events(task.id, 0);
    turn.emit({ type: 'message_delta', data: { text: '完成后的过期片段' } });
    turn.emit({ type: 'thread_started', data: { threadId: 'expired-thread' } });
    turn.emit({ type: 'activity', data: { message: '过期活动' } });
    assert.deepEqual(instance.store.events(task.id, 0), eventsAfterCompletion);
    assert.equal(instance.store.threadId(conv.id), 'external-thread');
  });

  it('does not start the next task until the active turn promise settles', async () => {
    const instance = await fixture();
    const conv = await conversation(instance);
    const first = await send(instance, conv.id, '第一项');
    await until(() => instance.runtime.turns.length === 1, 'first starts');
    const second = await send(instance, conv.id, '第二项');
    await nextLoop();
    assert.equal(instance.runtime.turns.length, 1);
    assert.equal(instance.store.getTask(second.task.id).status, 'queued');
    instance.runtime.turns[0]!.emit({ type: 'message_delta', data: { text: '第一项结果' } });
    instance.runtime.turns[0]!.complete();
    await until(() => instance.runtime.turns.length === 2, 'second starts after first completion');
    assert.equal(instance.store.getTask(first.task.id).status, 'completed');
    assert.equal(instance.runtime.turns[1]!.input.taskId, second.task.id);
    assert.deepEqual(instance.runtime.turns[1]!.input.history,
      [{ role: 'user', text: '第一项' }, { role: 'assistant', text: '第一项结果' }]);
    instance.runtime.turns[1]!.complete();
  });

  it('excludes future queued messages and orders completed task history as user-assistant pairs', async () => {
    let conversationId!: string;
    let firstId!: string;
    const instance = await fixture({ prepare(store) {
      conversationId = store.createConversation().id;
      firstId = store.enqueue(conversationId, '先回答的问题', randomUUID(), 'low').task.id;
      store.enqueue(conversationId, '未来才回答的问题', randomUUID(), 'low');
      store.enqueue(conversationId, '第三个问题', randomUUID(), 'low');
    } });
    await until(() => instance.runtime.turns.length === 1, 'first queued task starts');
    assert.equal(instance.runtime.turns[0]!.input.taskId, firstId);
    assert.deepEqual(instance.runtime.turns[0]!.input.history, []);
    instance.runtime.turns[0]!.emit({ type: 'message_delta', data: { text: '第一个回答' } });
    instance.runtime.turns[0]!.complete();
    await until(() => instance.runtime.turns.length === 2, 'second queued turn starts');
    assert.deepEqual(instance.runtime.turns[1]!.input.history,
      [{ role: 'user', text: '先回答的问题' }, { role: 'assistant', text: '第一个回答' }]);
    instance.runtime.turns[1]!.emit({ type: 'message_delta', data: { text: '第二个回答' } });
    instance.runtime.turns[1]!.complete();
    await until(() => instance.runtime.turns.length === 3, 'third queued turn starts');
    assert.deepEqual(instance.runtime.turns[2]!.input.history, [
      { role: 'user', text: '先回答的问题' }, { role: 'assistant', text: '第一个回答' },
      { role: 'user', text: '未来才回答的问题' }, { role: 'assistant', text: '第二个回答' },
    ]);
    instance.runtime.turns[2]!.complete();
  });

  it('aborts a cancelled turn and ignores its late output while keeping the next task queued', async () => {
    const runtime = new ControlledRuntime();
    runtime.settleOnAbort = false;
    const instance = await fixture({ runtime });
    const conv = await conversation(instance);
    const first = await send(instance, conv.id, '要取消的任务');
    await until(() => runtime.turns.length === 1, 'first starts');
    const active = runtime.turns[0]!;
    active.emit({ type: 'message_delta', data: { text: '保留部分' } });
    const second = await send(instance, conv.id, '等待中的任务');
    const cancelled = await instance.app.inject({ method: 'POST', url: `/v1/tasks/${first.task.id}/cancel`, headers });
    assert.equal(cancelled.statusCode, 200);
    assert.equal(cancelled.json().task.status, 'cancelled');
    assert.equal(active.signal.aborted, true);
    const before = instance.store.events(first.task.id, 0);
    active.emit({ type: 'message_delta', data: { text: '晚到污染' } });
    active.emit({ type: 'thread_started', data: { threadId: 'late-thread' } });
    active.emit({ type: 'activity', data: { message: '晚到活动' } });
    await nextLoop();
    assert.equal(runtime.turns.length, 1);
    assert.equal(instance.store.getTask(second.task.id).status, 'queued');
    assert.equal(instance.store.threadId(conv.id), null);
    assert.deepEqual(instance.store.events(first.task.id, 0), before);
    active.complete();
    await until(() => runtime.turns.length === 2, 'second waits for cancelled call to settle');
    assert.equal(instance.store.getTask(first.task.id).status, 'cancelled');
    assert.equal(instance.store.messages(conv.id).find(message => message.taskId === first.task.id && message.role === 'assistant')?.text, '保留部分');
    runtime.turns[1]!.complete();
  });

  it('distinguishes runtime requests for user action from an ordinary failed execution', async () => {
    const instance = await fixture();
    const conv = await conversation(instance);
    const inputTask = await send(instance, conv.id, '需要批准');
    await until(() => instance.runtime.turns.length === 1, 'input task starts');
    instance.runtime.turns[0]!.fail(new RuntimeInputRequiredError('请完成模型授权'));
    await until(() => instance.store.getTask(inputTask.task.id).status === 'waiting_for_input', 'explicit input error pauses');
    const failedTask = await send(instance, conv.id, '会失败');
    await until(() => instance.runtime.turns.length === 2, 'failure task starts');
    instance.runtime.turns[1]!.emit({ type: 'message_delta', data: { text: '失败前输出' } });
    instance.runtime.turns[1]!.fail(new Error('测试运行失败'));
    await until(() => instance.store.getTask(failedTask.task.id).status === 'failed', 'ordinary runtime error fails');
    assert.equal(instance.store.messages(conv.id).find(message => message.taskId === failedTask.task.id && message.role === 'assistant')?.text, '失败前输出');
    const oldTurn = instance.runtime.turns[1]!;
    const retry = await instance.app.inject({ method: 'POST', url: `/v1/tasks/${failedTask.task.id}/retry`, headers });
    assert.equal(retry.statusCode, 200);
    await until(() => instance.runtime.turns.length === 3, 'new attempt starts');
    const beforeLateEvents = instance.store.events(failedTask.task.id, 0);
    oldTurn.emit({ type: 'message_delta', data: { text: '旧尝试的片段' } });
    oldTurn.emit({ type: 'thread_started', data: { threadId: 'old-attempt-thread' } });
    oldTurn.emit({ type: 'activity', data: { message: '旧尝试活动' } });
    assert.deepEqual(instance.store.events(failedTask.task.id, 0), beforeLateEvents);
    assert.equal(instance.store.threadId(conv.id), null);
    instance.runtime.turns[2]!.emit({ type: 'message_delta', data: { text: '新尝试成功' } });
    instance.runtime.turns[2]!.complete();
    await until(() => instance.store.getTask(failedTask.task.id).status === 'completed', 'retry completes');
    assert.equal(instance.store.messages(conv.id).find(message => message.taskId === failedTask.task.id && message.role === 'assistant')?.text, '新尝试成功');
  });

  it('cancels waiting tasks idempotently and rejects cancellation of completed, failed or interrupted work', async () => {
    const instance = await fixture({ startWorker: false });
    const conv = await conversation(instance);
    const waiting = await send(instance, conv.id, '等待用户的任务');
    instance.store.claimNext();
    instance.store.finish(waiting.task.id, 'waiting_for_input', '请确认操作');
    const cancelled = await instance.app.inject({ method: 'POST', url: `/v1/tasks/${waiting.task.id}/cancel`, headers });
    assert.equal(cancelled.statusCode, 200);
    assert.equal(cancelled.json().task.status, 'cancelled');
    assert.equal(cancelled.json().task.error, null);
    const events = instance.store.events(waiting.task.id, 0);
    const duplicate = await instance.app.inject({ method: 'POST', url: `/v1/tasks/${waiting.task.id}/cancel`, headers });
    assert.equal(duplicate.statusCode, 200);
    assert.deepEqual(duplicate.json(), cancelled.json());
    assert.deepEqual(instance.store.events(waiting.task.id, 0), events);
    for (const status of ['completed', 'failed', 'interrupted'] as const) {
      const terminal = await send(instance, conv.id, `结束状态 ${status}`);
      instance.store.claimNext();
      instance.store.finish(terminal.task.id, status);
      const response = await instance.app.inject({ method: 'POST', url: `/v1/tasks/${terminal.task.id}/cancel`, headers });
      assert.equal(response.statusCode, 409);
      assert.equal(response.json().error.code, 'invalid_state');
      assert.equal(instance.store.getTask(terminal.task.id).status, status);
    }
  });

  it('interrupts active work on close, aborts it, closes the runtime and preserves queued work on disk', async () => {
    const runtime = new ControlledRuntime();
    runtime.settleOnAbort = false;
    const instance = await fixture({ runtime });
    const conv = await conversation(instance);
    const first = await send(instance, conv.id, '服务停止时正在执行');
    await until(() => runtime.turns.length === 1, 'active turn starts');
    const turn = runtime.turns[0]!;
    turn.emit({ type: 'message_delta', data: { text: '已持久化部分' } });
    const queued = await send(instance, conv.id, '停止时仍在排队');
    await instance.app.close();
    assert.equal(turn.signal.aborted, true);
    // The store is now closed: even a callback retained by an adapter must be ignored.
    assert.doesNotThrow(() => turn.emit({ type: 'message_delta', data: { text: '停止后的晚到内容' } }));
    instance.closed = true;
    assert.equal(runtime.closed, true);
    assert.equal(runtime.turns.length, 1);
    const reopened = new Store(instance.databasePath);
    try {
      assert.equal(reopened.getTask(first.task.id).status, 'interrupted');
      assert.equal(reopened.getTask(queued.task.id).status, 'queued');
      assert.equal(reopened.messages(conv.id).find(message => message.taskId === first.task.id && message.role === 'assistant')?.text, '已持久化部分');
    } finally { reopened.close(); }
  });
});