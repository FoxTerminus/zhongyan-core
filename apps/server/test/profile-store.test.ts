import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { FilePlanProfileStore, ProfileStoreError, type PlanProfile } from '../src/auth/profile-store.js';

const testRoot = fileURLToPath(new URL('../../../work/profile-store-tests/', import.meta.url));
function profile(hostId = randomUUID()): PlanProfile {
  return {
    version: 1, revision: randomUUID(), appName: 'personal_agent', hostId, clientId: 'issued-test-client',
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
