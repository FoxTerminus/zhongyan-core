import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OPENAI_OIDC } from '../src/auth/types.js';

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
const cliPath = fileURLToPath(new URL('../src/auth/cli.ts', import.meta.url));

function assertChildPath(root: string, target: string): void {
  const child = relative(root, target);
  assert.ok(child && !isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`),
    'Temporary test files must remain within their verified parent directory');
}

async function temporaryDirectory(): Promise<{ root: string; directory: string }> {
  const project = await realpath(projectRoot);
  const cachePath = join(project, '.cache');
  await mkdir(cachePath, { recursive: true });
  const cache = await realpath(cachePath);
  assertChildPath(project, cache);
  const testRoot = join(cache, 'plan-cli-tests');
  await mkdir(testRoot, { recursive: true });
  const root = await realpath(testRoot);
  assertChildPath(cache, root);
  return { root, directory: await mkdtemp(join(root, 'login-')) };
}

for (const mode of ['cancel-message', 'parent-disconnect'] as const) {
  test(`real CLI ${mode} releases its login lock without saving credentials`, { timeout: 20_000 }, async () => {
    const temporary = await temporaryDirectory();
    const directory = join(temporary.directory, 'registration');
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
      !/TOKEN|SECRET|API_KEY|^AGENT_|^NODE_OPTIONS$|^NODE_USE_ENV_PROXY$|_PROXY$/i.test(name)));
    env.AGENT_CHATGPT_APP_NAME = 'offline_cli_test';
    const child = spawn(process.execPath, [
      '--import', 'tsx', cliPath, 'login', '--open-source-ready', '--profile-dir', directory,
    ], { cwd: projectRoot, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
    let readyResolve!: () => void;
    let readyReject!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    let output = '';
    let errorOutput = '';
    let cancelledMessage = false;
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      // Never include the authorization URL or child output in assertion failures.
      output = (output + chunk).slice(-16_384);
      if (output.split(/\r?\n/).some(line => line.startsWith(`${OPENAI_OIDC.authorize}?`))) readyResolve();
    });
    child.stderr!.on('data', (chunk: string) => {
      errorOutput = (errorOutput + chunk).slice(-1024);
      if (errorOutput.includes('ChatGPT 登录已取消')) cancelledMessage = true;
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      child.once('error', () => {
        readyReject(new Error('The offline CLI test process could not start'));
        resolve({ code: null, signal: null });
      });
      child.once('exit', (code, signal) => {
        readyReject(new Error('The offline CLI exited before presenting its authorization URL'));
        resolve({ code, signal });
      });
    });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      readyReject(new Error('The offline CLI did not finish within the test deadline'));
      child.kill();
    }, 12_000);
    try {
      await ready;
      assert.equal(existsSync(join(directory, '.profile-lock')), true, 'The ready CLI must own its login lock');
      assert.equal(existsSync(join(directory, 'profile.json')), false);
      if (mode === 'cancel-message') {
        await new Promise<void>((resolve, reject) => {
          child.send({ type: 'plan-auth:cancel' }, error => {
            if (error) reject(new Error('The offline cancellation message could not be delivered'));
            else resolve();
          });
        });
      } else {
        child.disconnect();
      }
      const result = await exited;
      assert.equal(timedOut, false, 'Cancellation must complete without forcefully killing the child');
      assert.deepEqual(result, { code: 1, signal: null });
      assert.equal(cancelledMessage, true, 'The CLI must report graceful cancellation');
      assert.equal(existsSync(join(directory, '.profile-lock')), false);
      assert.equal(existsSync(join(directory, 'profile.json')), false);
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null && child.signalCode === null && child.pid) {
        child.kill();
        await exited;
      }
      const root = await realpath(temporary.root);
      const target = await realpath(temporary.directory);
      assertChildPath(root, target);
      await rm(target, { recursive: true, force: true });
    }
  });
}
