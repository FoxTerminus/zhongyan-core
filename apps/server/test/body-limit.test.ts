import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { Store } from '../src/store.js';
import { KnowledgeStore } from '../src/knowledge.js';
import { DisabledRuntime } from '../src/runtime/unavailable.js';

test('HTTP byte limit permits 32000 Chinese characters promised by the content schema', async () => {
  const token = 'test-token-for-chinese-body-boundary-only';
  const app = createApp({ store: new Store(':memory:'), knowledge: new KnowledgeStore(':memory:'), runtime: new DisabledRuntime(), authToken: token, startWorker: false });
  try {
    const response = await app.inject({ method: 'POST', url: '/v1/knowledge', headers: { authorization: `Bearer ${token}` }, payload: { title: '中文长资料', body: '中'.repeat(32000) } });
    assert.equal(response.statusCode, 201);
    assert.equal(response.json().note.body.length, 32000);
  } finally { await app.close(); }
});
