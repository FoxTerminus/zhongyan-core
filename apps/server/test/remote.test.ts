import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { it } from 'node:test';
import { RunnerFrameDecoder, MAX_RUNNER_FRAME_BYTES } from '../src/runtime/remote-protocol.js';
import { RemoteRuntime } from '../src/runtime/remote.js';
import type { RuntimeInput } from '../src/runtime/types.js';
import { Store } from '../src/store.js';
import { Worker } from '../src/worker.js';

const input: RuntimeInput = { taskId: 'task', conversationId: 'conversation', text: '测试', effort: 'high', threadId: null };
function mockTransport(make: (runId: string) => unknown[], split = false) {
  let calls = 0;
  const transport: typeof fetch = async (_url, options) => {
    calls++;
    const runId = JSON.parse(String(options?.body)).runId;
    const bytes = Buffer.from(make(runId).map(frame => JSON.stringify(frame) + '\n').join(''));
    return new Response(new ReadableStream({
      start(controller) {
        if (split) for (let index = 0; index < bytes.length; index++) controller.enqueue(bytes.subarray(index, index + 1));
        else controller.enqueue(bytes);
        controller.close();
      },
    }), { headers: { 'content-type': 'application/x-ndjson' } });
  };
  return { transport, calls: () => calls };
}
const accepted = (runId: string) => ({ type: 'accepted', runId, seq: 0 });
const terminal = (runId: string) => ({ type: 'terminal', runId, seq: 2, status: 'completed' });
const event = (runId: string) => ({ type: 'event', runId, seq: 1, event: { type: 'message_delta', data: { text: '白龙娘🌙' } } });
function adapter(fetch: typeof globalThis.fetch) { return new RemoteRuntime({ url: 'http://runner:8788', token: 'r'.repeat(32), fetch }); }

it('decodes split UTF-8 and newline boundaries while preserving ordered events', async () => {
  const mock = mockTransport(id => [accepted(id), event(id), terminal(id)], true);
  const client = adapter(mock.transport);
  const text: string[] = [];
  try { await client.run(input, value => { if (value.type === 'message_delta') text.push(value.data.text); }, new AbortController().signal); }
  finally { await client.close(); }
  assert.deepEqual(text, ['白龙娘🌙']); assert.equal(mock.calls(), 1);
});

it('rejects truncated, overlong and invalid UTF-8 frames with bounded output', () => {
  const decoder = new RunnerFrameDecoder();
  decoder.push(Buffer.from('{"type":'));
  assert.throws(() => decoder.finish());
  assert.throws(() => new RunnerFrameDecoder().push(Buffer.alloc(MAX_RUNNER_FRAME_BYTES + 1, 65)));
  assert.throws(() => new RunnerFrameDecoder(2).push(Buffer.from('abc')));
  assert.throws(() => new RunnerFrameDecoder().push(Buffer.from([255, 10])));
});

for (const [name, frames] of [
  ['missing terminal', (id: string) => [accepted(id), event(id)]],
  ['foreign run', (id: string) => [accepted(id), event(randomUUID()), terminal(id)]],
  ['repeated sequence', (id: string) => [accepted(id), event(id), event(id), terminal(id)]],
  ['events after terminal', (id: string) => [accepted(id), event(id), terminal(id), { ...event(id), seq: 3 }]],
] as const) {
  it(`marks ${name} interrupted and never retries the POST`, async () => {
    const mock = mockTransport(frames); const client = adapter(mock.transport);
    try { await assert.rejects(client.run(input, () => {}, new AbortController().signal), { name: 'RuntimeInterruptedError' }); assert.equal(mock.calls(), 1); }
    finally { await client.close(); }
  });
}

it('persists a broken stream as interrupted and keeps partial output for review', async () => {
  const mock = mockTransport(id => [accepted(id), event(id)]);
  const client = adapter(mock.transport), store = new Store(':memory:'), worker = new Worker(store, client);
  try {
    const conversation = store.createConversation();
    const task = store.enqueue(conversation.id, '真实状态回归', randomUUID(), 'low').task;
    worker.start();
    const deadline = Date.now() + 1500;
    while (['queued', 'running'].includes(store.getTask(task.id).status)) {
      assert.ok(Date.now() < deadline); await delay(5);
    }
    assert.equal(store.getTask(task.id).status, 'interrupted');
    assert.equal(store.messages(conversation.id).at(-1)?.text, '白龙娘🌙');
    assert.equal(mock.calls(), 1);
  } finally { await worker.close(); store.close(); }
});
