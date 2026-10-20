import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { CodexRuntime } from '../src/runtime/codex.js';
import { PLAN_APP, type PlanCredentialProvider, type PlanCredentialLease } from '../src/auth/types.js';
import { RuntimeCancelledError } from '../src/runtime/types.js';
import { input, harness, completed } from './helpers/codex-harness.js';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from '../src/worker.js';
import { Store } from '../src/store.js';
import { StoredPlanCredentialProvider } from '../src/auth/provider.js';
import { PlanOAuth } from '../src/auth/oauth.js';
import { OPENAI_OIDC, PLAN_SCOPES } from '../src/auth/types.js';
import type { PlanProfile } from '../src/auth/profile-store.js';
import { loadConfig } from '../src/config.js';

const providerConfiguration = { model_provider: 'openai_chatgpt_plan', mcp_servers: {}, model_providers: {
  openai_chatgpt_plan: { name: 'ChatGPT plan', base_url: 'https://api.openai.com/v1', env_key: 'ACCESS_TOKEN',
    wire_api: 'responses', requires_openai_auth: false, supports_websockets: false, http_headers: {}, env_http_headers: {}, query_params: {} },
} };
function fixture(options: { authenticated?: boolean; complete?: boolean; badConfig?: boolean } = {}) {
  let revision = 'one'; const acquisition: boolean[] = []; const requests: Record<string, any>[] = [];
  const launches: { args: string[]; environment: NodeJS.ProcessEnv; killed: boolean }[] = [];
  const replies: ((message: object) => void)[] = [];
  const lease = (): PlanCredentialLease => ({ accessToken: `test-token-${revision}`, revision, appName: 'personal_agent', expiresAt: Date.now() + 3600_000, codexHome: 'D:\\isolated-fixture\\codex-home' });
  const provider: PlanCredentialProvider = {
    inspect: async () => ({ authenticated: options.authenticated ?? true, expiresAt: lease().expiresAt, message: 'fixture status' }),
    acquire: async allowRefresh => { acquisition.push(allowRefresh); return lease(); },
  };
  const runtime = new CodexRuntime({ cwd: process.cwd(), planCredentials: provider, requestTimeoutMs: 200 }, (_command, args, _cwd, environment) => {
    const launch = { args, environment: environment!, killed: false }; launches.push(launch);
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    const stdout = new PassThrough();
    const reply = (message: object) => queueMicrotask(() => stdout.write(`${JSON.stringify(message)}\n`)); replies.push(reply);
    const stdin = new Writable({ write(chunk, _encoding, done) {
      const request = JSON.parse(chunk.toString()); requests.push(request);
      const result: Record<string, unknown> = {
        initialize: {}, 'model/list': { data: [{ model: 'model-from-catalog' }], nextCursor: null },
        'config/read': { config: options.badConfig ? { ...providerConfiguration, model_provider: 'other' } : providerConfiguration },
        'thread/start': { thread: { id: 'thread' } }, 'thread/resume': { thread: { id: 'thread' } },
        'turn/start': { turn: { id: `turn-${launches.length}`, status: 'inProgress' } }, 'turn/interrupt': {},
      };
      if (request.id !== undefined && request.method) reply({ id: request.id, result: result[request.method] ?? {} });
      if (request.method === 'turn/start' && options.complete !== false) reply({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: `turn-${launches.length}`, status: 'completed' } } });
      done();
    } });
    Object.assign(child, { stdin, stdout, stderr: new PassThrough(), kill() { launch.killed = true; queueMicrotask(() => child.emit('exit', null, 'SIGTERM')); return true; } });
    return child;
  });
  return { runtime, acquisition, requests, launches, replies, rotate() { revision = 'two'; } };
}

test('plan mode status reads only its own provider and does not fall back to desktop login', async () => {
  const missing = fixture({ authenticated: false });
  const status = await missing.runtime.getStatus();
  assert.equal(status.available, false); assert.equal(status.authenticated, false); assert.equal(missing.launches.length, 0);
  assert.equal(missing.acquisition.length, 0); await missing.runtime.close();
  const f = fixture(); assert.equal((await f.runtime.getStatus()).available, true);
  assert.deepEqual(f.acquisition, [false]); assert.equal(f.requests.some(request => request.method === 'account/read'), false);
  assert.equal(f.requests.some(request => request.method === 'thread/start'), false); await f.runtime.close();
});

test('plan runtime passes only dedicated token/home, fixed Responses provider and consistent app attribution', async () => {
  const f = fixture(); await f.runtime.run(input, () => {}, new AbortController().signal);
  assert.deepEqual(f.acquisition, [true]);
  const launch = f.launches[0]!;
  assert.equal(launch.environment.ACCESS_TOKEN, 'test-token-one');
  assert.equal(launch.environment.CODEX_HOME, 'D:\\isolated-fixture\\codex-home');
  assert.equal(launch.environment.AGENT_AUTH_TOKEN, undefined); assert.equal(launch.environment.OPENAI_API_KEY, undefined);
  assert.equal(launch.args.includes('model_provider="openai_chatgpt_plan"'), true);
  assert.equal(launch.args.includes('model_providers.openai_chatgpt_plan.requires_openai_auth=false'), true);
  assert.deepEqual(f.requests.find(request => request.method === 'initialize')!.params.clientInfo, PLAN_APP);
  assert.equal(f.requests.find(request => request.method === 'thread/start')!.params.modelProvider, 'openai_chatgpt_plan');
  assert.equal(f.requests.some(request => request.method.startsWith('account/')), false);
  await f.runtime.close();
});

test('renewed token replaces the child and resumes the saved thread without replaying the old task', async () => {
  const f = fixture(); await f.runtime.run(input, () => {}, new AbortController().signal);
  f.rotate(); await f.runtime.run({ ...input, text: 'follow up', threadId: 'thread' }, () => {}, new AbortController().signal);
  assert.equal(f.launches.length, 2); assert.equal(f.launches[0]!.killed, true);
  assert.equal(f.launches[1]!.environment.ACCESS_TOKEN, 'test-token-two');
  assert.equal(f.requests.filter(request => request.method === 'thread/start').length, 1);
  assert.equal(f.requests.filter(request => request.method === 'thread/resume').length, 1);
  assert.equal(f.requests.filter(request => request.method === 'turn/start').length, 2);
  await f.runtime.close();
});

test('status polling cannot rotate credentials or kill an active turn; cancellation still stops its child', async () => {
  const f = fixture({ complete: false }); const controller = new AbortController();
  const running = f.runtime.run(input, () => {}, controller.signal); void running.catch(() => {});
  while (!f.requests.some(request => request.method === 'turn/start')) await new Promise(resolve => setImmediate(resolve));
  f.rotate(); assert.equal((await f.runtime.getStatus()).available, true);
  assert.equal(f.acquisition.length, 1); assert.equal(f.launches.length, 1); assert.equal(f.launches[0]!.killed, false);
  controller.abort(); await assert.rejects(running, RuntimeCancelledError); assert.equal(f.launches[0]!.killed, true); await f.runtime.close();
});

test('unexpected effective provider config fails before a thread starts, with no fallback', async () => {
  const f = fixture({ badConfig: true });
  await assert.rejects(f.runtime.run(input, () => {}, new AbortController().signal), /配置未通过/);
  assert.equal(f.requests.some(request => request.method === 'thread/start'), false); assert.equal(f.launches[0]!.killed, true);
  await f.runtime.close();
});

test('model and auth configuration remain explicit and default runtime stays disabled', () => {
  const env = { AGENT_AUTH_TOKEN: 'test-only-credential-at-least-32-characters' };
  assert.equal(loadConfig(env).runtime, 'disabled'); assert.equal(loadConfig(env).authMode, 'codex-login');
  const config = loadConfig({ ...env, AGENT_CODEX_AUTH: 'chatgpt-plan', AGENT_CHATGPT_PROFILE_DIR: 'isolated-profile' });
  assert.equal(config.authMode, 'chatgpt-plan'); assert.match(config.planProfileDir, /isolated-profile$/);
  assert.throws(() => loadConfig({ ...env, AGENT_CODEX_AUTH: 'api-key' }));
});

test('queued Worker task can renew an expired plan session even when read-only status is unavailable', { timeout: 4000 }, async () => {
  const testRoot = fileURLToPath(new URL('../../../work/plan-worker-tests/', import.meta.url));
  mkdirSync(testRoot, { recursive: true }); const directory = mkdtempSync(join(testRoot, 'worker-'));
  const store = new Store(join(directory, 'state.sqlite'));
  let refreshes = 0;
  let saved: PlanProfile = { version: 2, revision: randomUUID(), appName: 'personal_agent', hostId: `urn:uuid:${randomUUID()}`,
    clientId: 'issued-client', issuer: OPENAI_OIDC.issuer, subject: 'subject', accessToken: 'expired-access',
    refreshToken: 'old-refresh', idToken: 'old-id', scopes: [...PLAN_SCOPES], expiresAt: Date.now() - 1, savedAt: Date.now() - 3600_000 };
  const credentials = new StoredPlanCredentialProvider({ read: async () => saved,
    withLock: async callback => callback(), write: async profile => { saved = profile; }, prepareRuntimeHome: async () => directory,
  }, new PlanOAuth({ verifyIdentity: async () => ({ subject: 'subject' }), fetch: (async () => {
    refreshes++; return new Response(JSON.stringify({ access_token: 'new-access', refresh_token: 'new-refresh', token_type: 'Bearer', expires_in: 3600 }));
  }) as typeof fetch }));
  const f = harness((request, reply) => {
    if (request.method === 'config/read') { reply({ id: request.id, result: { config: providerConfiguration } }); return true; }
    if (request.method === 'turn/start') {
      reply({ id: request.id, result: { turn: { id: 'turn', status: 'inProgress' } } }); reply(completed()); return true;
    }
  }, { planCredentials: credentials });
  const worker = new Worker(store, f.runtime);
  try {
    assert.equal((await f.runtime.getStatus()).available, false); assert.equal(refreshes, 0);
    const conversation = store.createConversation();
    const task = store.enqueue(conversation.id, 'explicit task', randomUUID(), 'low').task;
    worker.start();
    const deadline = Date.now() + 2000;
    while (!['completed', 'waiting_for_input', 'failed'].includes(store.getTask(task.id).status)) {
      assert.ok(Date.now() < deadline, 'worker should settle'); await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(store.getTask(task.id).status, 'completed'); assert.equal(refreshes, 1);
    assert.equal(saved.refreshToken, 'new-refresh');
  } finally {
    await worker.close(); store.close();
    const root = realpathSync(testRoot); const target = realpathSync(directory); const child = relative(root, target);
    assert.ok(child && !isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`));
    rmSync(target, { recursive: true, force: true });
  }
});
