import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { FilePlanProfileStore, ProfileStoreError, parsePlanProfile, type PlanProfile } from '../src/auth/profile-store.js';
import { PlanOAuth } from '../src/auth/oauth.js';
import { isPlanHostId, PLAN_SCOPES } from '../src/auth/types.js';

const testRoot = fileURLToPath(new URL('../../../work/profile-store-tests/', import.meta.url));
function profile(hostId = `urn:uuid:${randomUUID()}`): PlanProfile {
  return {
    version: 2, revision: randomUUID(), appName: 'personal_agent', hostId, clientId: 'issued-test-client',
    issuer: 'https://auth.openai.com', subject: 'test-subject',
    accessToken: 'fake-access-test-only', refreshToken: 'fake-refresh-test-only', idToken: 'fake-id-test-only',
    scopes: ['openid', 'chatgpt.tokens.use.direct'],
    expiresAt: Date.now() + 3_600_000, savedAt: Date.now(),
  };
}

// All fixtures are synthetic and stay beneath project/work; no existing account files are read.
describe('isolated plan profile store', { concurrency: false }, () => {
  let temporary: string;
  let directory: string;
  let store: FilePlanProfileStore;
  beforeEach(async () => {
    await mkdir(testRoot, { recursive: true });
    temporary = await mkdtemp(join(testRoot, 'profile-'));
    directory = join(temporary, 'registration');
    store = new FilePlanProfileStore(directory);
  });
  afterEach(async () => {
    const root = await realpath(testRoot);
    const target = await realpath(temporary);
    const child = relative(root, target);
    assert.ok(child && !isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`));
    await rm(target, { recursive: true, force: true });
  });

  it('does not create credentials or directories during a missing-profile read', async () => {
    assert.equal(await store.read(), null);
    assert.deepEqual(await readdir(temporary), []);
  });

  it('persists a stable host identity and protected profile independently of runtime files', async () => {
    const hostId = await store.hostId();
    assert.ok(isPlanHostId(hostId));
    assert.equal(await new FilePlanProfileStore(directory).hostId(), hostId);
    const expected = profile(hostId);
    await store.write(expected);
    assert.deepEqual(await new FilePlanProfileStore(directory).read(), expected);
    const runtimeHome = await store.prepareRuntimeHome();
    assert.equal(runtimeHome, join(directory, 'codex-home'));
    assert.deepEqual(await readdir(runtimeHome), []);
    assert.deepEqual((await readdir(directory)).sort(), ['codex-home', 'host.json', 'profile.json']);
    if (process.platform !== 'win32') {
      assert.equal((await lstat(directory)).mode & 0o777, 0o700);
      assert.equal((await lstat(join(directory, 'profile.json'))).mode & 0o777, 0o600);
    }
  });

  it('passes the persisted UUIDv4 URI through real storage, OAuth and the saved registration', async () => {
    const hostId = await store.hostId();
    const calls: URLSearchParams[] = [];
    const oauth = new PlanOAuth({
      fetch: (async (_url, init) => {
        calls.push(new URLSearchParams(String(init?.body)));
        return new Response(JSON.stringify({
          access_token: 'test-access', refresh_token: 'test-refresh', id_token: 'test-id',
          token_type: 'Bearer', expires_in: 3600, scope: PLAN_SCOPES.join(' '),
        }));
      }) as typeof fetch,
      verifyIdentity: async () => ({ subject: 'test-subject' }),
    });
    const attempt = oauth.begin('http://127.0.0.1:34567/auth/callback', hostId, await store.read());
    const authorization = new URL(attempt.authorizationUrl);
    assert.ok(isPlanHostId(hostId));
    assert.equal(authorization.searchParams.get('ext_agent_host_id'), hostId);
    const callback = new URL(attempt.redirectUri);
    callback.search = new URLSearchParams({
      state: authorization.searchParams.get('state')!, code: 'test-code', client_id: 'test-issued-client',
    }).toString();
    const signedIn = await attempt.complete(callback.toString());
    await store.write(signedIn);
    assert.equal(calls.length, 1);
    const restored = new FilePlanProfileStore(directory);
    assert.equal(await restored.hostId(), hostId);
    assert.deepEqual(await restored.read(), signedIn);
    assert.equal(signedIn.version, 2);
    assert.equal(signedIn.hostId, hostId);
    assert.equal(new URL(oauth.begin(attempt.redirectUri, await restored.hostId(), await restored.read())
      .authorizationUrl).searchParams.get('ext_agent_host_id'), hostId);
  });

  it('migrates a legacy host under the owned lock without changing its UUID or writing during profile reads', async () => {
    const initial = profile(await store.hostId());
    await store.write(initial);
    const bareUuid = initial.hostId.slice('urn:uuid:'.length);
    const legacyProfile = { ...initial, version: 1, hostId: bareUuid };
    const hostPath = join(directory, 'host.json');
    const profilePath = join(directory, 'profile.json');
    const legacyBytes = `${JSON.stringify(legacyProfile)}\n`;
    await writeFile(hostPath, JSON.stringify({ version: 1, hostId: bareUuid }));
    await writeFile(profilePath, legacyBytes);
    const restored = new FilePlanProfileStore(directory);
    assert.deepEqual(await restored.read(), initial);
    assert.deepEqual(parsePlanProfile(legacyProfile), initial);
    assert.equal(await readFile(profilePath, 'utf8'), legacyBytes);
    await restored.withLock(async () => {
      assert.ok((await lstat(join(directory, '.profile-lock'))).isDirectory());
      assert.equal(await restored.hostId(), initial.hostId);
      assert.deepEqual(JSON.parse(await readFile(hostPath, 'utf8')), { version: 2, hostId: initial.hostId });
    });
    // A later normal write upgrades profile metadata while preserving the entire token set.
    const oauth = new PlanOAuth();
    const attempt = oauth.begin('http://127.0.0.1:34567/auth/callback', await restored.hostId(), await restored.read());
    assert.equal(new URL(attempt.authorizationUrl).searchParams.get('ext_agent_host_id'), initial.hostId);
    await restored.write((await restored.read())!);
    assert.deepEqual(JSON.parse(await readFile(profilePath, 'utf8')), initial);
    assert.equal(await new FilePlanProfileStore(directory).hostId(), initial.hostId);
    assert.equal((await readdir(directory)).some(name => name.endsWith('.tmp') || name === '.profile-lock'), false);
  });

  it('rejects invalid host metadata instead of silently generating a replacement identity', async () => {
    await store.hostId();
    for (const invalid of [
      { version: 1, hostId: 'not-a-uuid' },
      { version: 1, hostId: '11111111-1111-7111-8111-111111111111' },
      { version: 2, hostId: '11111111-1111-4111-8111-111111111111' },
      { version: 2, hostId: 'urn:uuid:test-host' },
    ]) {
      const bytes = JSON.stringify(invalid);
      await writeFile(join(directory, 'host.json'), bytes);
      await assert.rejects(store.hostId(), ProfileStoreError);
      assert.equal(await readFile(join(directory, 'host.json'), 'utf8'), bytes);
      assert.throws(() => parsePlanProfile({ ...profile(), ...invalid }), ProfileStoreError);
    }
  });

  it('serializes same-instance callbacks and supports nested write/host calls without deadlock', async () => {
    const events: string[] = [];
    await Promise.all([
      store.withLock(async () => {
        events.push('first-start');
        const hostId = await store.hostId();
        await delay(30);
        await store.write(profile(hostId));
        events.push('first-end');
      }),
      store.withLock(async () => { events.push('second'); assert.ok(await store.read()); }),
    ]);
    assert.deepEqual(events, ['first-start', 'first-end', 'second']);
  });

  it('uses an exclusive filesystem lock across independent instances and releases after failure', async () => {
    await store.hostId();
    const other = new FilePlanProfileStore(directory);
    const events: string[] = [];
    let ready!: () => void;
    const acquired = new Promise<void>(resolve => { ready = resolve; });
    const first = store.withLock(async () => {
      events.push('first-start');
      ready();
      await delay(150);
      events.push('first-end');
    });
    await acquired;
    await Promise.all([first, other.withLock(async () => { events.push('second'); })]);
    assert.deepEqual(events, ['first-start', 'first-end', 'second']);
    const failure = new Error('test domain failure');
    await assert.rejects(store.withLock(async () => { throw failure; }), error => error === failure);
    await other.withLock(async () => undefined);
    assert.equal((await readdir(directory)).includes('.profile-lock'), false);
  });

  it('keeps a real second process outside an owned refresh lock until its owner releases', { timeout: 10_000 }, async () => {
    await store.hostId();
    const helper = fileURLToPath(new URL('./helpers/profile-store-child.ts', import.meta.url));
    const child = fork(helper, [directory], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !/TOKEN|SECRET|API_KEY|^AGENT_/i.test(name))),
    });
    const deadline = setTimeout(() => child.kill(), 8_000);
    try {
      const [message] = await once(child, 'message'); assert.equal(message.type, 'locked');
      let entered = false;
      await assert.rejects(store.withLock(async () => { entered = true; }), ProfileStoreError);
      assert.equal(entered, false);
      const released = once(child, 'message');
      child.send({ type: 'release' });
      const [releaseMessage] = await released; assert.equal(releaseMessage.type, 'released');
      await store.withLock(async () => { entered = true; }); assert.equal(entered, true);
      assert.equal((await readdir(directory)).includes('.profile-lock'), false);
    } finally { clearTimeout(deadline); child.kill(); }
  });

  it('does not remove a lock left by another process or reinterpret it as authorization', async () => {
    await store.hostId();
    await mkdir(join(directory, '.profile-lock'));
    await assert.rejects(store.withLock(async () => assert.fail('must not run')), ProfileStoreError);
    assert.ok((await lstat(join(directory, '.profile-lock'))).isDirectory());
  });

  it('rejects malformed and oversized replacements without losing the previous credentials', async () => {
    const original = profile();
    await store.write(original);
    await assert.rejects(store.write({ ...original, clientId: 'dynamic_agent_client' }), ProfileStoreError);
    await assert.rejects(store.write({ ...original, appName: 'unsafe originator' }), ProfileStoreError);
    await assert.rejects(store.write({ ...original, accessToken: 'x'.repeat(32_000), refreshToken: 'y'.repeat(32_000), idToken: 'z'.repeat(32_000) }), ProfileStoreError);
    assert.deepEqual(await store.read(), original);
    assert.equal((await readdir(directory)).some(name => name.endsWith('.tmp') || name === '.profile-lock'), false);
    const next = { ...original, revision: randomUUID(), accessToken: 'new-access', refreshToken: 'new-refresh' };
    await store.write(next);
    assert.deepEqual(await store.read(), next);
  });

  it('rejects invalid stored schema and oversized data with errors that contain no secret content', async () => {
    await store.write(profile());
    const path = join(directory, 'profile.json');
    await writeFile(path, '{"private":"secret-never-log"}');
    await assert.rejects(store.read(), error => error instanceof ProfileStoreError && !error.message.includes('secret-never-log'));
    await writeFile(path, 'secret-never-log'.repeat(5_000));
    await assert.rejects(store.read(), error => error instanceof ProfileStoreError && !error.message.includes('secret-never-log'));
  });

  it('rejects a directory junction/symlink before traversing it', async () => {
    const outside = join(temporary, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'do-not-touch'), 'fixture');
    await symlink(outside, directory, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(store.read(), ProfileStoreError);
    await assert.rejects(store.hostId(), ProfileStoreError);
    assert.deepEqual(await readdir(outside), ['do-not-touch']);
  });

  it('fails closed for permissions that allow other local users', async () => {
    if (process.platform === 'win32') {
      // A normal directory inherits the project's broad DACL and must not be adopted silently.
      await mkdir(directory);
      await assert.rejects(store.hostId(), ProfileStoreError);
      assert.deepEqual(await readdir(directory), []);
    } else {
      await store.write(profile());
      await chmod(join(directory, 'profile.json'), 0o644);
      await assert.rejects(store.read(), ProfileStoreError);
      await assert.rejects(store.write(profile()), ProfileStoreError);
    }
  });
});
