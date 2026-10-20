import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, writeFile, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadSecret } from '../read-secret.mjs';
import { prepareDeployment } from '../prepare.mjs';
import { deploymentSecretModesSafe } from '../preflight.mjs';

const testRoot = fileURLToPath(new URL('../../work/deploy-secret-tests/', import.meta.url));
async function withTestDirectory(callback) {
  await mkdir(testRoot, { recursive: true });
  const directory = await mkdtemp(join(testRoot, 'fixture-'));
  try { await callback(directory); }
  finally {
    const target = await realpath(directory);
    const child = relative(await realpath(testRoot), target);
    assert.ok(child && !isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`));
    await rm(target, { recursive: true, force: true });
  }
}
const asDirectoryUrl = directory => pathToFileURL(`${directory}${sep}`);
const template = '# synthetic deployment fixture\nAGENT_DOMAIN=\n';
async function prepareFixture(directory) {
  await writeFile(join(directory, 'deployment.env.example'), template);
}
function prepareWithRestrictiveUmask(directory) {
  // A separate process owns the umask change so concurrent tests are unaffected.
  const moduleUrl = new URL('../prepare.mjs', import.meta.url).href;
  const script = `import { prepareDeployment } from ${JSON.stringify(moduleUrl)};
    import { pathToFileURL } from 'node:url';
    process.umask(0o077);
    await prepareDeployment(pathToFileURL(process.argv[1] + '/'), () => {});`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, directory], {
    encoding: 'utf8', timeout: 10_000, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
}

test('file secrets load independently, reject conflicts and bound input', async () => {
  await withTestDirectory(async directory => {
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
  });
});

test('preparation creates independent synthetic secrets and preserves existing content and configuration', async () => {
  await withTestDirectory(async directory => {
    await prepareFixture(directory);
    const reports = [];
    await prepareDeployment(asDirectoryUrl(directory), message => reports.push(message));
    const devicePath = join(directory, '.secrets', 'agent-auth-token');
    const runnerPath = join(directory, '.secrets', 'runner-auth-token');
    const device = await readFile(devicePath, 'utf8');
    const runner = await readFile(runnerPath, 'utf8');
    assert.match(device, /^[a-f0-9]{64}\n$/);
    assert.match(runner, /^[a-f0-9]{64}\n$/);
    assert.notEqual(device, runner);
    assert.equal(await readFile(join(directory, 'deployment.env'), 'utf8'), template);
    await writeFile(join(directory, 'deployment.env'), '# keep this synthetic config\n');
    await prepareDeployment(asDirectoryUrl(directory), message => reports.push(message));
    assert.equal(await readFile(devicePath, 'utf8'), device);
    assert.equal(await readFile(runnerPath, 'utf8'), runner);
    assert.equal(await readFile(join(directory, 'deployment.env'), 'utf8'), '# keep this synthetic config\n');
    assert.equal(reports.some(value => value.includes(device.trim()) || value.includes(runner.trim())), false);
  });
});

test('preflight metadata rules require private directory and exact container-readable modes', () => {
  assert.equal(deploymentSecretModesSafe(0o40700, 0o100444, 'linux'), true);
  for (const mode of [0o400, 0o600, 0o640, 0o644, 0o666]) {
    assert.equal(deploymentSecretModesSafe(0o40700, 0o100000 | mode, 'linux'), false);
  }
  assert.equal(deploymentSecretModesSafe(0o40755, 0o100444, 'linux'), false);
  assert.equal(deploymentSecretModesSafe(0o40700, 0o100444, 'win32'), false);
});

test('Linux preparation defeats umask 077 for newly created secret files', {
  skip: process.platform !== 'linux' && 'Requires real Linux POSIX permissions; Windows does not verify this behavior.',
}, async () => {
  await withTestDirectory(async directory => {
    await prepareFixture(directory);
    prepareWithRestrictiveUmask(directory);
    const dir = await lstat(join(directory, '.secrets'));
    assert.equal(dir.mode & 0o777, 0o700);
    for (const filename of ['agent-auth-token', 'runner-auth-token']) {
      const stat = await lstat(join(directory, '.secrets', filename));
      assert.equal(stat.mode & 0o777, 0o444);
      assert.equal(deploymentSecretModesSafe(dir.mode, stat.mode), true);
    }
  });
});

test('Linux preparation preserves existing 0400/0600/0444 secrets while preflight rejects unreadable modes', {
  skip: process.platform !== 'linux' && 'Requires real Linux POSIX permissions; Windows does not verify this behavior.',
}, async () => {
  for (const mode of [0o400, 0o600, 0o444]) {
    await withTestDirectory(async directory => {
      await prepareFixture(directory);
      const secrets = join(directory, '.secrets');
      await mkdir(secrets, { mode: 0o700 });
      const path = join(secrets, 'agent-auth-token');
      const contents = `${'a'.repeat(64)}\n`;
      await writeFile(path, contents);
      await chmod(path, mode);
      prepareWithRestrictiveUmask(directory);
      const dir = await lstat(secrets);
      const stat = await lstat(path);
      assert.equal(stat.mode & 0o777, mode);
      assert.equal(await readFile(path, 'utf8'), contents);
      assert.equal(deploymentSecretModesSafe(dir.mode, stat.mode), mode === 0o444);
      assert.equal((await lstat(join(secrets, 'runner-auth-token'))).mode & 0o777, 0o444);
    });
  }
});
