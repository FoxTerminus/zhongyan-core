import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextImmediate } from 'node:timers/promises';
import { z } from 'zod';
import { KnowledgeStore } from '../src/knowledge.js';
import { createKnowledgeToolRegistry } from '../src/tools/knowledge.js';
import { defineReadOnlyTool, ToolRegistry } from '../src/tools/registry.js';
import { RuntimeCancelledError, RuntimeInputRequiredError, type RuntimeEvent } from '../src/runtime/types.js';
import { harness, input, completed, type Rpc } from './helpers/codex-harness.js';

const call = (id: string, overrides: Rpc = {}) => ({
  id, method: 'item/tool/call', params: {
    threadId: 'thread', turnId: 'turn', callId: id, namespace: null,
    tool: 'knowledge_search', arguments: { query: '材料' }, ...overrides,
  },
});
const startAck = (id: unknown) => ({ id, result: { turn: { id: 'turn', status: 'inProgress' } } });
const resultData = (rpc: Rpc) => JSON.parse(rpc.result.contentItems[0].text);

function emptyReader(counter: { reads: number }) {
  return {
    search() { counter.reads++; return []; },
    get() { counter.reads++; throw new Error('not configured'); },
  };
}

test('experimental protocol requires both explicit opt-in and an available registry; defaults remain stable', async t => {
  const counter = { reads: 0 };
  const toolRegistry = createKnowledgeToolRegistry(emptyReader(counter));
  for (const options of [{ toolRegistry }, { knowledgeTools: 'experimental' as const }]) {
    const h = harness((request, reply) => {
      if (request.method !== 'turn/start') return false;
      reply(startAck(request.id)); reply(completed()); return true;
    }, options);
    t.after(() => h.runtime.close());
    await h.runtime.run(input, () => {}, new AbortController().signal);
    assert.equal(h.requests.find(r => r.method === 'initialize').params.capabilities, undefined);
    assert.equal(h.requests.find(r => r.method === 'thread/start').params.dynamicTools, undefined);
  }
  assert.equal(counter.reads, 0);
});

test('status with experimental tools performs discovery only and never reads reference material', async t => {
  const counter = { reads: 0 };
  const h = harness(() => false, { knowledgeTools: 'experimental', toolRegistry: createKnowledgeToolRegistry(emptyReader(counter)) });
  t.after(() => h.runtime.close());
  await h.runtime.getStatus();
  assert.deepEqual(h.requests.map(r => r.method), ['initialize', 'initialized', 'account/read', 'model/list']);
  assert.equal(counter.reads, 0);
});

test('only the two permitted function definitions are advertised; shell and other integrations stay disabled', async t => {
  const tools = new ToolRegistry([
    defineReadOnlyTool('knowledge_search', 'Test search', z.object({}).strict(), () => []),
    defineReadOnlyTool('knowledge_write', 'Must not be advertised', z.object({}).strict(), () => []),
  ]);
  const h = harness((request, reply) => {
    if (request.method !== 'turn/start') return false;
    reply(startAck(request.id)); reply(completed()); return true;
  }, { knowledgeTools: 'experimental', toolRegistry: tools });
  t.after(() => h.runtime.close());
  await h.runtime.run(input, () => {}, new AbortController().signal);
  const initialize = h.requests.find(r => r.method === 'initialize');
  assert.deepEqual(initialize.params.capabilities, { experimentalApi: true });
  const thread = h.requests.find(r => r.method === 'thread/start');
  assert.deepEqual(thread.params.dynamicTools.map((tool: Rpc) => [tool.name, tool.type, tool.deferLoading]), [['knowledge_search', 'function', false]]);
  assert.equal(thread.params.dynamicTools[0].inputSchema.additionalProperties, false);
  assert.match(thread.params.developerInstructions, /untrusted data/);
  assert.equal(thread.params.approvalPolicy, 'never');
  assert.equal(thread.params.sandbox, 'read-only');
  const args = h.launches[0]!.args;
  for (const feature of ['shell_tool', 'unified_exec', 'apps', 'plugins', 'hooks', 'browser_use', 'computer_use']) {
    assert.ok(args.some((arg, index) => arg === '--disable' && args[index + 1] === feature));
  }
  assert.ok(args.includes('mcp_servers={}'));
});

test('mock app-server can search and read a real saved note through bounded tool responses', async t => {
  const store = new KnowledgeStore(':memory:');
  const note = store.create({ title: '申请材料', body: '准备成绩证明，十月截止。', source: '用户保存的清单' });
  t.after(() => store.close());
  const h = harness((request, reply) => {
    if (request.method === 'turn/start') {
      reply(startAck(request.id)); reply(call('search')); return true;
    }
    if (request.id === 'search' && request.result) {
      reply(call('read', { tool: 'knowledge_get', arguments: { id: note.id, expectedRevision: 1 } })); return true;
    }
    if (request.id === 'read' && request.result) { reply(completed()); return true; }
    return false;
  }, { knowledgeTools: 'experimental', toolRegistry: createKnowledgeToolRegistry(store) });
  t.after(() => h.runtime.close());
  const events: RuntimeEvent[] = [];
  await h.runtime.run(input, event => events.push(event), new AbortController().signal);
  const search = h.requests.find(r => r.id === 'search');
  const read = h.requests.find(r => r.id === 'read');
  for (const response of [search, read]) {
    assert.deepEqual(Object.keys(response.result).sort(), ['contentItems', 'success']);
    assert.equal(response.result.success, true);
    assert.equal(response.result.contentItems[0].type, 'inputText');
    assert.equal(resultData(response).trust, 'untrusted_reference_data');
  }
  assert.equal(resultData(search).data.results[0].revision, 1);
  assert.equal(resultData(read).data.text, note.body);
  assert.equal(resultData(read).data.source, note.source);
  assert.equal(events.filter(event => event.type === 'activity').length, 2);
});

test('wrong thread, wrong turn, namespace, unknown tool and invalid arguments never read the store', async t => {
  const counter = { reads: 0 };
  const invalidCalls = [
    call('wrong-thread', { threadId: 'another-thread' }),
    call('wrong-turn', { turnId: 'old-turn' }),
    call('namespace', { namespace: 'shell' }),
    call('unknown', { tool: 'knowledge_write' }),
    call('invalid-args', { arguments: { query: '材料', command: 'read filesystem' } }),
    call('invalid-packet', { surprising: 'unsupported protocol field' }),
  ];
  const ids = new Set(invalidCalls.map(value => value.id));
  let replies = 0;
  const h = harness((request, reply) => {
    if (request.method === 'turn/start') {
      reply(startAck(request.id)); for (const value of invalidCalls) reply(value); return true;
    }
    if (ids.has(request.id) && request.result) {
      if (++replies === invalidCalls.length) reply(completed());
      return true;
    }
    return false;
  }, { knowledgeTools: 'experimental', toolRegistry: createKnowledgeToolRegistry(emptyReader(counter)) });
  t.after(() => h.runtime.close());
  await h.runtime.run(input, () => {}, new AbortController().signal);
  assert.equal(counter.reads, 0);
  for (const id of ids) assert.equal(h.requests.find(r => r.id === id).result.success, false);
  assert.equal(resultData(h.requests.find(r => r.id === 'wrong-turn')).error.code, 'invalid_context');
  assert.equal(resultData(h.requests.find(r => r.id === 'invalid-args')).error.code, 'invalid_arguments');
});

test('tool call arriving before turn acknowledgement waits for the authoritative turn ID', async t => {
  let acknowledged = false;
  let readBeforeAck = false;
  const h = harness((request, reply) => {
    if (request.method === 'turn/start') {
      reply(call('early'));
      setImmediate(() => { acknowledged = true; reply(startAck(request.id)); });
      return true;
    }
    if (request.id === 'early' && request.result) { reply(completed()); return true; }
    return false;
  }, { knowledgeTools: 'experimental', toolRegistry: createKnowledgeToolRegistry({
    search() { readBeforeAck = !acknowledged; return []; }, get() { throw new Error('unused'); },
  }) });
  t.after(() => h.runtime.close());
  await h.runtime.run(input, () => {}, new AbortController().signal);
  assert.equal(readBeforeAck, false);
  assert.equal(h.requests.find(r => r.id === 'early').result.success, true);
});

test('duplicate call ID reuses its result and different parameters are rejected', async t => {
  const counter = { reads: 0 };
  let received = 0;
  const h = harness((request, reply) => {
    if (request.method === 'turn/start') {
      reply(startAck(request.id));
      reply(call('first', { callId: 'same' }));
      reply(call('duplicate', { callId: 'same' }));
      reply(call('conflict', { callId: 'same', arguments: { query: 'different' } }));
      return true;
    }
    if (['first', 'duplicate', 'conflict'].includes(request.id) && request.result) {
      if (++received === 3) reply(completed()); return true;
    }
    return false;
  }, { knowledgeTools: 'experimental', toolRegistry: createKnowledgeToolRegistry(emptyReader(counter)) });
  t.after(() => h.runtime.close());
  await h.runtime.run(input, () => {}, new AbortController().signal);
  assert.equal(counter.reads, 1);
  assert.deepEqual(h.requests.find(r => r.id === 'first').result, h.requests.find(r => r.id === 'duplicate').result);
  assert.equal(resultData(h.requests.find(r => r.id === 'conflict')).error.code, 'call_conflict');
});

test('disabled experimental tools refuse persisted dynamic calls and never access knowledge', async t => {
  const counter = { reads: 0 };
  const h = harness((request, reply) => {
    if (request.method !== 'turn/start') return false;
    reply(startAck(request.id)); reply(call('disabled')); return true;
  }, { toolRegistry: createKnowledgeToolRegistry(emptyReader(counter)) });
  t.after(() => h.runtime.close());
  await assert.rejects(h.runtime.run(input, () => {}, new AbortController().signal), RuntimeInputRequiredError);
  assert.equal(counter.reads, 0);
  assert.equal(h.requests.find(r => r.id === 'disabled').error.code, -32601);
});

test('resume preserves protocol compatibility instead of pretending to add tools to an old thread', async t => {
  const h = harness((request, reply) => {
    if (request.method !== 'turn/start') return false;
    reply(startAck(request.id)); reply(completed()); return true;
  }, { knowledgeTools: 'experimental', toolRegistry: createKnowledgeToolRegistry(emptyReader({ reads: 0 })) });
  t.after(() => h.runtime.close());
  await h.runtime.run({ ...input, threadId: 'thread' }, () => {}, new AbortController().signal);
  const resume = h.requests.find(r => r.method === 'thread/resume');
  assert.equal(resume.params.dynamicTools, undefined);
  assert.match(resume.params.developerInstructions, /untrusted data/);
  assert.equal(h.requests.some(r => r.method === 'thread/start'), false);
});

test('cancellation suppresses delayed tool results and interrupts the running turn', async t => {
  let release: ((value: []) => void) | undefined;
  let started: () => void = () => {};
  const reading = new Promise<void>(resolve => { started = resolve; });
  const h = harness((request, reply) => {
    if (request.method !== 'turn/start') return false;
    reply(startAck(request.id)); reply(call('delayed')); return true;
  }, { knowledgeTools: 'experimental', toolRegistry: createKnowledgeToolRegistry({
    search() { started(); return new Promise<[]>(resolve => { release = resolve; }); },
    get() { throw new Error('unused'); },
  }) });
  t.after(() => h.runtime.close());
  const controller = new AbortController();
  const running = h.runtime.run(input, () => {}, controller.signal);
  await reading;
  controller.abort();
  await assert.rejects(running, RuntimeCancelledError);
  release?.([]);
  await nextImmediate();
  assert.equal(h.requests.some(r => r.id === 'delayed' && r.result), false);
  assert.equal(h.requests.some(r => r.method === 'turn/interrupt'), true);
  assert.equal(h.killed, true);
});

test('cancellation before turn acknowledgement abandons pending tool calls without reading', async t => {
  const controller = new AbortController();
  const counter = { reads: 0 };
  const h = harness((request, reply) => {
    if (request.method !== 'turn/start') return false;
    reply(call('early-cancel'));
    setImmediate(() => controller.abort());
    return true;
  }, { knowledgeTools: 'experimental', toolRegistry: createKnowledgeToolRegistry(emptyReader(counter)) });
  t.after(() => h.runtime.close());
  await assert.rejects(h.runtime.run(input, () => {}, controller.signal), RuntimeCancelledError);
  assert.equal(counter.reads, 0);
  assert.equal(h.requests.some(r => r.id === 'early-cancel' && r.result), false);
});

test('late output from a completed attempt cannot enter a subsequent attempt', async t => {
  let release: ((value: []) => void) | undefined;
  let starts = 0;
  const h = harness((request, reply) => {
    if (request.method !== 'turn/start') return false;
    reply(startAck(request.id));
    if (++starts === 1) {
      reply(call('old-result'));
      setImmediate(() => reply(completed()));
    } else {
      release?.([]);
      setImmediate(() => reply(completed()));
    }
    return true;
  }, { knowledgeTools: 'experimental', toolRegistry: createKnowledgeToolRegistry({
    search() { return new Promise<[]>(resolve => { release = resolve; }); }, get() { throw new Error('unused'); },
  }) });
  t.after(() => h.runtime.close());
  await h.runtime.run(input, () => {}, new AbortController().signal);
  await h.runtime.run({ ...input, taskId: 'next', threadId: 'thread' }, () => {}, new AbortController().signal);
  await nextImmediate();
  assert.equal(h.requests.some(r => r.id === 'old-result' && r.result), false);
});
test('tool backend failure is a sanitized failed tool response, not a successful read', async t => {
  const h = harness((request, reply) => {
    if (request.method === 'turn/start') { reply(startAck(request.id)); reply(call('backend-failure')); return true; }
    if (request.id === 'backend-failure' && request.result) { reply(completed()); return true; }
    return false;
  }, { knowledgeTools: 'experimental', toolRegistry: createKnowledgeToolRegistry({
    search() { throw new Error('SECRET path or SQL'); }, get() { throw new Error('unused'); },
  }) });
  t.after(() => h.runtime.close());
  await h.runtime.run(input, () => {}, new AbortController().signal);
  const response = h.requests.find(r => r.id === 'backend-failure');
  assert.equal(response.result.success, false);
  assert.equal(resultData(response).error.code, 'tool_failed');
  assert.equal(JSON.stringify(response).includes('SECRET'), false);
});

test('unsupported experimental initialization fails explicitly without retrying stable mode', async t => {
  const h = harness((request, reply) => {
    if (request.method !== 'initialize') return false;
    reply({ id: request.id, error: { code: -32602, message: 'Unsupported capability' } });
    return true;
  }, { knowledgeTools: 'experimental', toolRegistry: createKnowledgeToolRegistry(emptyReader({ reads: 0 })) });
  t.after(() => h.runtime.close());
  const status = await h.runtime.getStatus();
  assert.equal(status.available, false);
  assert.equal(h.requests.filter(r => r.method === 'initialize').length, 1);
  assert.equal(h.requests.some(r => r.method === 'thread/start'), false);
  assert.equal(h.killed, true);
});

test('each turn has a bounded tool-call budget', async t => {
  const counter = { reads: 0 };
  let next = 0;
  const h = harness((request, reply) => {
    if (request.method === 'turn/start') {
      reply(startAck(request.id)); reply(call('budget-0')); return true;
    }
    if (typeof request.id === 'string' && request.id.startsWith('budget-') && request.result) {
      next++;
      if (next < 33) reply(call('budget-' + next)); else reply(completed());
      return true;
    }
    return false;
  }, { knowledgeTools: 'experimental', toolRegistry: createKnowledgeToolRegistry(emptyReader(counter)) });
  t.after(() => h.runtime.close());
  await h.runtime.run(input, () => {}, new AbortController().signal);
  assert.equal(counter.reads, 32);
  assert.equal(resultData(h.requests.find(r => r.id === 'budget-32')).error.code, 'tool_limit_reached');
});