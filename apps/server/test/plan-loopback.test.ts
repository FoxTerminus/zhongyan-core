import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorizePlanProfile } from '../src/auth/loopback.js';
import { PlanOAuth } from '../src/auth/oauth.js';
import { PLAN_SCOPES, PlanAuthError } from '../src/auth/types.js';
import type { PlanProfile } from '../src/auth/profile-store.js';

function memoryStore() {
  let locked = false; const writes: PlanProfile[] = [];
  return { writes, get locked() { return locked; }, hostId: async () => 'urn:uuid:fixture-host', read: async () => null,
    async withLock<T>(callback: () => Promise<T>) { locked = true; try { return await callback(); } finally { locked = false; } },
    async write(profile: PlanProfile) { assert.equal(locked, true); writes.push(profile); },
  };
}
const oauth = () => new PlanOAuth({
  fetch: (async () => new Response(JSON.stringify({ token_type: 'Bearer', access_token: 'test-access', refresh_token: 'test-refresh',
    id_token: 'test-id', scope: PLAN_SCOPES.join(' '), expires_in: 3600 }))) as typeof fetch,
  verifyIdentity: async () => ({ subject: 'test-subject' }),
});

test('administrator loopback listens before publishing URL, validates callback and saves once', async () => {
  const store = memoryStore();
  let callbackRequest: Promise<Response> | undefined;
  await authorizePlanProfile(store, { onReady(authorizationUrl) {
    const auth = new URL(authorizationUrl); const callback = new URL(auth.searchParams.get('redirect_uri')!);
    assert.equal(callback.hostname, '127.0.0.1'); assert.ok(Number(callback.port) > 0);
    callback.search = new URLSearchParams({ code: 'test-code', state: auth.searchParams.get('state')!, client_id: 'issued-client' }).toString();
    callbackRequest = fetch(callback);
  } }, oauth());
  assert.equal((await callbackRequest)!.status, 200); assert.equal(store.writes.length, 1); assert.equal(store.locked, false);
});

test('administrator cancellation closes pending loopback without token exchange or writes', async () => {
  const store = memoryStore(); const controller = new AbortController(); let redirectUri = '';
  await assert.rejects(authorizePlanProfile(store, { signal: controller.signal, onReady(url) {
    redirectUri = new URL(url).searchParams.get('redirect_uri')!; controller.abort();
  } }, oauth()), PlanAuthError);
  assert.equal(store.writes.length, 0); assert.equal(store.locked, false);
  await assert.rejects(fetch(redirectUri));
});

test('cancellation keeps lock until an already started credential commit settles', async () => {
  const store = memoryStore(); const controller = new AbortController();
  let releaseWrite = () => {}; const writeGate = new Promise<void>(resolve => { releaseWrite = resolve; });
  let enteredWrite = () => {}; const writing = new Promise<void>(resolve => { enteredWrite = resolve; });
  const originalWrite = store.write;
  store.write = async profile => { enteredWrite(); await writeGate; await originalWrite(profile); };
  const login = authorizePlanProfile(store, { signal: controller.signal, onReady(url) {
    const auth = new URL(url); const callback = new URL(auth.searchParams.get('redirect_uri')!);
    callback.search = new URLSearchParams({ code: 'test', state: auth.searchParams.get('state')!, client_id: 'issued-client' }).toString();
    void fetch(callback).catch(() => {});
  } }, oauth());
  void login.catch(() => {}); await writing; controller.abort();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(store.locked, true);
  releaseWrite(); await assert.rejects(login, PlanAuthError); assert.equal(store.locked, false);
});
