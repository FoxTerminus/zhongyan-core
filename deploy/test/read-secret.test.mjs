import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSecret } from '../read-secret.mjs';

test('file secrets load independently, reject conflicts and bound input', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-secret-test-'));
  try {
    const device = join(directory, 'device'); const runner = join(directory, 'runner');
    await writeFile(device, `${'a'.repeat(64)}\n`); await writeFile(runner, 'b'.repeat(64));
    const env = { AGENT_AUTH_TOKEN_FILE: device, AGENT_RUNNER_AUTH_TOKEN_FILE: runner };
    await loadSecret(env, 'AGENT_AUTH_TOKEN'); await loadSecret(env, 'AGENT_RUNNER_AUTH_TOKEN');
    assert.equal(env.AGENT_AUTH_TOKEN, 'a'.repeat(64)); assert.equal(env.AGENT_RUNNER_AUTH_TOKEN, 'b'.repeat(64));
    assert.equal(env.AGENT_AUTH_TOKEN_FILE, undefined);
    await assert.rejects(loadSecret({ X_FILE: device, X: 'existing' }, 'X'), /Conflicting/);
    await writeFile(device, 'x'.repeat(4097));
    await assert.rejects(loadSecret({ X_FILE: device }, 'X'), /Invalid/);
    await writeFile(device, 'short'); await assert.rejects(loadSecret({ X_FILE: device }, 'X'), /Invalid/);
    await writeFile(device, `${'x'.repeat(40)} y`); await assert.rejects(loadSecret({ X_FILE: device }, 'X'), /Invalid/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
