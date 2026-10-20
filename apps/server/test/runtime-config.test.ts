import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

test('knowledge tools stay disabled unless the explicit experimental value is configured', () => {
  const base = { AGENT_AUTH_TOKEN: 'test-only-token-with-at-least-32-characters' };
  assert.equal(loadConfig(base).knowledgeTools, 'disabled');
  assert.equal(loadConfig({ ...base, AGENT_CODEX_KNOWLEDGE_TOOLS: 'disabled' }).knowledgeTools, 'disabled');
  assert.equal(loadConfig({ ...base, AGENT_CODEX_KNOWLEDGE_TOOLS: 'experimental' }).knowledgeTools, 'experimental');
  for (const value of ['true', '1', 'enabled', '']) {
    assert.throws(() => loadConfig({ ...base, AGENT_CODEX_KNOWLEDGE_TOOLS: value }));
  }
});