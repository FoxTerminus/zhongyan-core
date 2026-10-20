import { test } from 'node:test';
import { harness, input, delta, completed } from './helpers/codex-harness.js';
import assert from 'node:assert/strict';
import { buildCodexEnvironment } from '../src/runtime/codex.js';
import { DisabledRuntime } from '../src/runtime/unavailable.js';
import {
  RuntimeCancelledError, RuntimeInputRequiredError, RuntimeUnavailableError,
  type RuntimeEvent,
} from '../src/runtime/types.js';

test('disabled runtime is explicit and never simulates a model answer', async () => {
  const runtime = new DisabledRuntime();
  assert.equal((await runtime.getStatus()).available, false);
  await assert.rejects(runtime.run(), RuntimeUnavailableError);
});

test('model subprocess receives no service or business credentials', () => {
  assert.deepEqual(buildCodexEnvironment({
    PATH: '/bin', SYSTEMROOT: 'system', CODEX_HOME: '/isolated/codex',
    AGENT_AUTH_TOKEN: 'do not inherit', OPENAI_API_KEY: 'no billing',
    MAIL_PASSWORD: 'private', RANDOM_BUSINESS_VALUE: 'private',
  }), { PATH: '/bin', SYSTEMROOT: 'system', CODEX_HOME: '/isolated/codex' });
});

test('status uses read-only discovery, filters account details and discovers model dynamically', async t => {
  const h = harness();
  t.after(() => h.runtime.close());
  const status = await h.runtime.getStatus();
  assert.equal(status.available, true);
  assert.deepEqual(status.models, [{ id: 'available-model', displayName: 'Available model' }]);
  assert.equal(JSON.stringify(status).includes('private@example.invalid'), false);
  assert.deepEqual(h.requests.map(request => request.method), ['initialize', 'initialized', 'account/read', 'model/list']);
  assert.deepEqual(h.requests[2].params, { refreshToken: false });
});

test('API-key authentication never silently bills an API account', async t => {
  const h = harness((request, reply) => {
    if (request.method !== 'account/read') return false;
    reply({ id: request.id, result: { account: { type: 'apiKey' } } });
    return true;
  });
  t.after(() => h.runtime.close());
  const status = await h.runtime.getStatus();
  assert.equal(status.available, false);
  await assert.rejects(h.runtime.run(input, () => {}, new AbortController().signal), RuntimeUnavailableError);
  assert.equal(h.requests.some(request => request.method === 'turn/start'), false);
});

test('streaming ignores other threads and deduplicates completed agent message', async t => {
  const h = harness((request, reply) => {
    if (request.method === 'turn/start') {
      reply({ id: request.id, result: { turn: { id: 'turn', status: 'inProgress' } } });
      reply(delta('wrong', 'unrelated'));
      reply(delta('你好'));
      reply({ method: 'item/completed', params: { threadId: 'thread', turnId: 'turn', item: { type: 'agentMessage', id: 'answer', text: '你好' } } });
      reply(completed());
      return true;
    }
    return false;
  });
  t.after(() => h.runtime.close());
  const events: RuntimeEvent[] = [];
  await h.runtime.run(input, event => events.push(event), new AbortController().signal);
  assert.deepEqual(events, [
    { type: 'thread_started', data: { threadId: 'thread' } },
    { type: 'message_delta', data: { text: '你好' } },
  ]);
  const thread = h.requests.find(request => request.method === 'thread/start');
  const turn = h.requests.find(request => request.method === 'turn/start');
  assert.equal(thread.params.sandbox, 'read-only');
  assert.equal(thread.params.approvalPolicy, 'never');
  assert.deepEqual(turn.params.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  assert.equal('model' in turn.params, false);
});

test('failed resume surfaces an error without silently losing conversation history', async t => {
  const h = harness((request, reply) => {
    if (request.method !== 'thread/resume') return false;
    reply({ id: request.id, error: { code: -1, message: 'private detail' } });
    return true;
  });
  t.after(() => h.runtime.close());
  await assert.rejects(h.runtime.run({ ...input, threadId: 'old-thread' }, () => {}, new AbortController().signal), error =>
    error instanceof RuntimeUnavailableError && !error.message.includes('private detail'));
  assert.equal(h.requests.some(request => request.method === 'thread/start'), false);
  assert.equal(h.requests.some(request => request.method === 'turn/start'), false);
});

test('unknown approval is refused and task stops instead of waiting forever', async t => {
  const h = harness((request, reply) => {
    if (request.method !== 'turn/start') return false;
    reply({ id: request.id, result: { turn: { id: 'turn' } } });
    reply({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread', turnId: 'turn', command: 'do a write' } });
    return true;
  });
  t.after(() => h.runtime.close());
  const events: RuntimeEvent[] = [];
  await assert.rejects(h.runtime.run(input, event => events.push(event), new AbortController().signal), RuntimeInputRequiredError);
  assert.deepEqual(h.requests.find(request => request.id === 'approval-1').result, { decision: 'decline' });
  assert.equal(h.killed, true);
  assert.equal(events.some(event => event.type === 'approval_required'), true);
});

test('abort interrupts the known turn and terminates the child process', async t => {
  const controller = new AbortController();
  const h = harness((request, reply) => {
    if (request.method !== 'turn/start') return false;
    reply({ id: request.id, result: { turn: { id: 'turn' } } });
    setImmediate(() => controller.abort());
    return true;
  });
  t.after(() => h.runtime.close());
  await assert.rejects(h.runtime.run(input, () => {}, controller.signal), RuntimeCancelledError);
  assert.equal(h.requests.some(request => request.method === 'turn/interrupt'), true);
  assert.equal(h.killed, true);
});

test('cancel before turn/start acknowledgement cannot orphan a running model', async t => {
  const controller = new AbortController();
  const h = harness(request => {
    if (request.method !== 'turn/start') return false;
    setImmediate(() => controller.abort());
    return true; // Simulate inference beginning but no RPC acknowledgement.
  });
  t.after(() => h.runtime.close());
  await assert.rejects(h.runtime.run(input, () => {}, controller.signal), RuntimeCancelledError);
  assert.equal(h.killed, true);
});

test('failed turn never counts as successful generation', async t => {
  const h = harness((request, reply) => {
    if (request.method !== 'turn/start') return false;
    reply({ id: request.id, result: { turn: { id: 'turn' } } });
    reply(completed('failed'));
    return true;
  });
  t.after(() => h.runtime.close());
  await assert.rejects(h.runtime.run(input, () => {}, new AbortController().signal), RuntimeUnavailableError);
});

test('request timeout is bounded and process is cleaned up', async t => {
  const h = harness(request => request.method === 'initialize');
  t.after(() => h.runtime.close());
  assert.equal((await h.runtime.getStatus()).available, false);
  assert.equal(h.killed, true);
});

test('inherited MCP configuration is blocked before opening a thread', async t => {
  const h = harness((request, reply) => {
    if (request.method !== 'config/read') return false;
    reply({ id: request.id, result: { config: { mcp_servers: { arbitrary: { command: 'private-tool' } } } } });
    return true;
  });
  t.after(() => h.runtime.close());
  await assert.rejects(h.runtime.run(input, () => {}, new AbortController().signal), RuntimeUnavailableError);
  assert.equal(h.requests.some(request => request.method === 'thread/start'), false);
});

test('old same-thread notifications before start acknowledgement cannot finish or contaminate the new turn', async t => {
  let settled = false;
  let wasStillRunning = false;
  const h = harness((request, reply) => {
    if (request.method !== 'turn/start') return false;
    reply({ method: 'turn/started', params: { threadId: 'thread', turn: { id: 'previous-turn' } } });
    reply({ method: 'item/agentMessage/delta', params: { threadId: 'thread', turnId: 'previous-turn', itemId: 'old', delta: 'OLD PRIVATE TEXT' } });
    reply({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'previous-turn', status: 'completed' } } });
    setImmediate(() => {
      reply({ id: request.id, result: { turn: { id: 'new-turn', status: 'inProgress' } } });
      setImmediate(() => {
        wasStillRunning = !settled;
        reply({ method: 'item/agentMessage/delta', params: { threadId: 'thread', turnId: 'new-turn', itemId: 'new', delta: 'NEW TEXT' } });
        reply({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'new-turn', status: 'completed' } } });
      });
    });
    return true;
  });
  t.after(() => h.runtime.close());
  const events: RuntimeEvent[] = [];
  const running = h.runtime.run(input, event => events.push(event), new AbortController().signal);
  void running.then(() => { settled = true; });
  await running;
  assert.equal(wasStillRunning, true);
  assert.deepEqual(events.filter(event => event.type === 'message_delta').map(event => event.data.text), ['NEW TEXT']);
});

test('matching notifications received before the start response are replayed after authoritative acknowledgement', async t => {
  const h = harness((request, reply) => {
    if (request.method !== 'turn/start') return false;
    reply(delta('early correct output'));
    reply(completed());
    setImmediate(() => reply({ id: request.id, result: { turn: { id: 'turn' } } }));
    return true;
  });
  t.after(() => h.runtime.close());
  const events: RuntimeEvent[] = [];
  await h.runtime.run(input, event => events.push(event), new AbortController().signal);
  assert.deepEqual(events.filter(event => event.type === 'message_delta').map(event => event.data.text), ['early correct output']);
});

test('unidentified notifications cannot inject text, errors or terminal status', async t => {
  const h = harness((request, reply) => {
    if (request.method !== 'turn/start') return false;
    reply({ id: request.id, result: { turn: { id: 'turn' } } });
    reply({ method: 'item/agentMessage/delta', params: { threadId: 'thread', itemId: 'wrong', delta: 'unidentified' } });
    reply({ method: 'item/completed', params: { threadId: 'thread', item: { id: 'wrong', type: 'agentMessage', text: 'unidentified' } } });
    reply({ method: 'error', params: { threadId: 'thread', willRetry: false } });
    reply({ method: 'turn/completed', params: { threadId: 'thread', turn: { status: 'failed' } } });
    setImmediate(() => { reply(delta('identified')); reply(completed()); });
    return true;
  });
  t.after(() => h.runtime.close());
  const events: RuntimeEvent[] = [];
  await h.runtime.run(input, event => events.push(event), new AbortController().signal);
  assert.deepEqual(events.filter(event => event.type === 'message_delta').map(event => event.data.text), ['identified']);
});

test('pre-acknowledgement buffering is bounded and overflow stops the child', async t => {
  const h = harness((request, reply) => {
    if (request.method !== 'turn/start') return false;
    reply(delta('x'.repeat(270_000)));
    return true;
  });
  t.after(() => h.runtime.close());
  const events: RuntimeEvent[] = [];
  await assert.rejects(h.runtime.run(input, event => events.push(event), new AbortController().signal), RuntimeUnavailableError);
  assert.equal(events.some(event => event.type === 'message_delta'), false);
  assert.equal(h.killed, true);
});
test('start acknowledgement and large valid output in one stdout chunk do not consume the early buffer budget', async t => {
  const parts = Array.from({ length: 160 }, (_, index) => `${index}:` + 'x'.repeat(2048));
  const h = harness(request => {
    if (request.method !== 'turn/start') return false;
    h.replyBatch([
      { id: request.id, result: { turn: { id: 'turn', status: 'inProgress' } } },
      ...parts.map(text => delta(text)),
      completed(),
    ]);
    return true;
  });
  t.after(() => h.runtime.close());
  const events: RuntimeEvent[] = [];
  await h.runtime.run(input, event => events.push(event), new AbortController().signal);
  assert.deepEqual(events.filter(event => event.type === 'message_delta').map(event => event.data.text), parts);
  assert.equal(h.killed, false);
});

test('same-chunk acknowledgement replays only matching early events before processing later output', async t => {
  const h = harness(request => {
    if (request.method !== 'turn/start') return false;
    h.replyBatch([
      { method: 'item/agentMessage/delta', params: { threadId: 'thread', turnId: 'old-turn', itemId: 'old', delta: 'OLD' } },
      delta('early-current'),
      { id: request.id, result: { turn: { id: 'turn' } } },
      delta('after-ack-current'),
      completed(),
    ]);
    return true;
  });
  t.after(() => h.runtime.close());
  const events: RuntimeEvent[] = [];
  await h.runtime.run(input, event => events.push(event), new AbortController().signal);
  assert.deepEqual(events.filter(event => event.type === 'message_delta').map(event => event.data.text), ['early-current', 'after-ack-current']);
});

test('actual pre-acknowledgement message count remains bounded even when acknowledgement follows in the same chunk', async t => {
  const h = harness(request => {
    if (request.method !== 'turn/start') return false;
    h.replyBatch([
      ...Array.from({ length: 129 }, () => delta('before acknowledgement')),
      { id: request.id, result: { turn: { id: 'turn' } } },
      completed(),
    ]);
    return true;
  });
  t.after(() => h.runtime.close());
  const events: RuntimeEvent[] = [];
  await assert.rejects(h.runtime.run(input, event => events.push(event), new AbortController().signal), RuntimeUnavailableError);
  assert.equal(events.some(event => event.type === 'message_delta'), false);
  assert.equal(h.killed, true);
});