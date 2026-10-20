import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createIdentityVerifier, PlanOAuth } from '../src/auth/oauth.js';
import { OPENAI_OIDC, PLAN_APP, PLAN_SCOPES, PlanAuthError } from '../src/auth/types.js';
import { StoredPlanCredentialProvider } from '../src/auth/provider.js';
import type { PlanProfile } from '../src/auth/profile-store.js';

const now = 1_800_000_000_000;
const profile = (overrides: Partial<PlanProfile> = {}): PlanProfile => ({
  version: 2, revision: 'revision-one', appName: 'personal_agent', hostId: 'urn:uuid:11111111-1111-4111-8111-111111111111', clientId: 'issued-client',
  issuer: OPENAI_OIDC.issuer, subject: 'test-subject', accessToken: 'test-access', refreshToken: 'test-refresh',
  idToken: 'test-identity', scopes: [...PLAN_SCOPES], expiresAt: now + 3_600_000, savedAt: now, ...overrides,
});
const tokens = (overrides = {}) => ({ access_token: 'new-access', refresh_token: 'new-refresh', id_token: 'new-id',
  token_type: 'Bearer', expires_in: 3600, scope: PLAN_SCOPES.join(' '), ...overrides });
function fixture(overrides: { tokens?: object; verify?: (token: string, expected: any) => Promise<{ subject: string }>; status?: number } = {}) {
  const calls: { url: string; init: RequestInit; body: URLSearchParams }[] = [];
  const identities: unknown[] = [];
  const oauth = new PlanOAuth({ now: () => now,
    fetch: (async (url, init) => {
      calls.push({ url: String(url), init: init!, body: new URLSearchParams(String(init?.body)) });
      return new Response(JSON.stringify(overrides.tokens ?? tokens()), { status: overrides.status ?? 200 });
    }) as typeof fetch,
    verifyIdentity: overrides.verify ?? (async (_token, expected) => { identities.push(expected); return { subject: 'test-subject' }; }),
  });
  const attempt = oauth.begin('http://127.0.0.1:34567/auth/callback', 'urn:uuid:11111111-1111-4111-8111-111111111111', null);
  const auth = new URL(attempt.authorizationUrl);
  const callback = (params: Record<string, string> = {}) => {
    const url = new URL(attempt.redirectUri); url.search = new URLSearchParams({
      code: 'test-code', state: auth.searchParams.get('state')!, client_id: 'issued-client', ...params,
    }).toString(); return url.toString();
  };
  return { oauth, attempt, auth, callback, calls, identities };
}

test('dynamic registration uses issued client, exact loopback, state/nonce and S256; callback consumes once', async () => {
  const f = fixture();
  assert.equal(f.auth.origin + f.auth.pathname, OPENAI_OIDC.authorize);
  assert.equal(f.auth.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(f.auth.searchParams.get('agent_name_hint'), PLAN_APP.name);
  assert.equal(f.auth.searchParams.get('ext_agent_host_id'), profile().hostId);
  const saved = await f.attempt.complete(f.callback());
  assert.equal(saved.clientId, 'issued-client'); assert.equal(saved.subject, 'test-subject');
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0]!.url, OPENAI_OIDC.token);
  const form = f.calls[0]!.body;
  assert.equal(form.get('redirect_uri'), f.attempt.redirectUri);
  assert.equal(form.get('client_id'), 'issued-client'); assert.equal(form.get('resource'), OPENAI_OIDC.resource);
  assert.equal(form.has('client_secret'), false); assert.equal(f.calls[0]!.init.redirect, 'error');
  assert.equal(createHash('sha256').update(form.get('code_verifier')!).digest('base64url'), f.auth.searchParams.get('code_challenge'));
  assert.deepEqual(f.identities[0], { clientId: 'issued-client', nonce: f.auth.searchParams.get('nonce'), subject: undefined, now });
  await assert.rejects(f.attempt.complete(f.callback()), PlanAuthError); assert.equal(f.calls.length, 1);
});

test('authorization rejects bare UUIDs, malformed URIs and mismatched saved hosts before any network request', () => {
  const f = fixture();
  for (const hostId of [
    '11111111-1111-4111-8111-111111111111', 'host', 'urn:uuid:test-host',
    'urn:uuid:11111111-1111-7111-8111-111111111111',
    'urn:uuid:11111111-1111-4111-7111-111111111111',
    `${profile().hostId}?query`, `${profile().hostId}\n`,
    'https://example.com/host',
  ]) assert.throws(() => f.oauth.begin(f.attempt.redirectUri, hostId, null), PlanAuthError);
  assert.throws(() => f.oauth.begin(f.attempt.redirectUri,
    'urn:uuid:22222222-2222-4222-8222-222222222222', profile()), PlanAuthError);
  assert.equal(f.calls.length, 0);
});

test('wrong state, OAuth denial, duplicate parameters and unissued client never exchange a code', async () => {
  for (const callback of [
    (f: ReturnType<typeof fixture>) => f.callback({ state: 'wrong' }),
    (f: ReturnType<typeof fixture>) => f.callback({ error: 'access_denied' }),
    (f: ReturnType<typeof fixture>) => f.callback({ client_id: 'dynamic_agent_client' }),
    (f: ReturnType<typeof fixture>) => f.callback() + '&state=second',
    (f: ReturnType<typeof fixture>) => f.callback().replace('127.0.0.1', 'localhost'),
  ]) {
    const f = fixture(); await assert.rejects(f.attempt.complete(callback(f)), PlanAuthError); assert.equal(f.calls.length, 0);
  }
});

test('expired transaction and unsafe callback locations are rejected', async () => {
  let clock = now;
  const oauth = new PlanOAuth({ now: () => clock });
  const attempt = oauth.begin('http://127.0.0.1:10000/auth/callback', 'urn:uuid:11111111-1111-4111-8111-111111111111', null);
  clock += 600_000;
  const url = new URL(attempt.redirectUri); url.search = new URL(attempt.authorizationUrl).search;
  await assert.rejects(attempt.complete(url.toString()), PlanAuthError);
  for (const redirect of ['https://example.org/auth/callback', 'http://localhost:1234/auth/callback', 'http://127.0.0.1:1234/callback']) {
    assert.throws(() => oauth.begin(redirect, 'urn:uuid:11111111-1111-4111-8111-111111111111', null), PlanAuthError);
  }
});

test('returning authorization preserves registration, omits sensitive hints, and rejects a switched client', async () => {
  const f = fixture(); const attempt = f.oauth.begin(f.attempt.redirectUri, 'urn:uuid:11111111-1111-4111-8111-111111111111', profile());
  const auth = new URL(attempt.authorizationUrl);
  assert.equal(auth.searchParams.get('client_id'), 'issued-client');
  assert.equal(auth.searchParams.has('agent_name_hint'), false); assert.equal(auth.searchParams.has('id_token_hint'), false);
  const callback = new URL(attempt.redirectUri); callback.search = new URLSearchParams({ code: 'code', state: auth.searchParams.get('state')!, client_id: 'wrong-client' }).toString();
  await assert.rejects(attempt.complete(callback.toString()), PlanAuthError); assert.equal(f.calls.length, 0);
});

test('missing plan scopes, invalid token shape and raw endpoint errors are safely rejected', async () => {
  for (const response of [tokens({ scope: 'openid profile email' }), tokens({ token_type: 'Basic' }), tokens({ expires_in: -1 })]) {
    const f = fixture({ tokens: response }); await assert.rejects(f.attempt.complete(f.callback()), PlanAuthError);
  }
  const f = fixture({ status: 400, tokens: { error_description: 'private-refresh-token-and-email' } });
  await assert.rejects(f.attempt.complete(f.callback()), (error: Error) => !error.message.includes('private-refresh'));
});

test('token endpoint diagnostics distinguish restrictions and configuration without leaking raw responses', async () => {
  const cases = [
    { status: 403, body: { error: { code: 'unsupported_country_region_territory', message: 'private-email-token' } }, code: 'access_restricted', expected: 'unsupported_country_region_territory' },
    { status: 400, body: { error: 'invalid_client', error_description: 'private-email-token' }, code: 'configuration', expected: 'invalid_client' },
    { status: 400, body: { error: 'invalid_grant' }, code: 'sign_in_required', expected: 'invalid_grant' },
    { status: 429, body: { detail: 'private-email-token' }, code: 'network', expected: 'JSON 响应' },
    { status: 400, body: { error: 'temporarily_unavailable' }, code: 'network', expected: 'temporarily_unavailable' },
    { status: 400, body: { error: 'server_error' }, code: 'network', expected: 'server_error' },
    { status: 403, body: { error: { code: 'private-email-token', message: 'private-email-token' } }, code: 'access_restricted', expected: 'JSON 响应' },
  ] as const;
  for (const item of cases) {
    const f = fixture({ status: item.status, tokens: item.body });
    await assert.rejects(f.attempt.complete(f.callback()), (error: unknown) => {
      assert.ok(error instanceof PlanAuthError);
      assert.equal(error.code, item.code);
      assert.match(error.message, new RegExp(`HTTP ${item.status}`));
      assert.ok(error.message.includes(item.expected));
      assert.ok(!error.message.includes('private-email-token'));
      return true;
    });
    assert.equal(f.calls.length, 1);
  }
});

test('non-JSON and oversized endpoint failures stay bounded and do not expose response content', async () => {
  for (const body of ['<!DOCTYPE html>private-email-token', JSON.stringify({ error: 'private-email-token'.repeat(5000) })]) {
    const oauth = new PlanOAuth({ fetch: (async () => new Response(body, { status: 403,
      headers: { 'x-request-id': 'request-test-123' } })) as typeof fetch });
    await assert.rejects(oauth.requestTokens({ grant_type: 'test' }), (error: unknown) => {
      assert.ok(error instanceof PlanAuthError);
      assert.equal(error.code, 'access_restricted');
      assert.match(error.message, /HTTP 403/);
      assert.match(error.message, /非 JSON 或不可读响应/);
      assert.match(error.message, /request-test-123/);
      assert.ok(!error.message.includes('private-email-token'));
      return true;
    });
  }
});

test('a region-restricted refresh preserves the existing profile and performs no automatic retry', async () => {
  const store = memoryStore(profile({ expiresAt: now - 1 }));
  const f = fixture({ status: 403, tokens: { error: { code: 'unsupported_country_region_territory' } } });
  const provider = new StoredPlanCredentialProvider(store, f.oauth, () => now);
  const before = await store.read();
  await assert.rejects(provider.acquire(true), (error: unknown) => error instanceof PlanAuthError && error.code === 'access_restricted');
  assert.equal(f.calls.length, 1);
  assert.equal(store.writes.length, 0);
  assert.deepEqual(await store.read(), before);
});

test('invalid or oversized diagnostic request IDs never reach display messages', async () => {
  for (const id of ['private@example.invalid', 'a'.repeat(101)]) {
    const oauth = new PlanOAuth({ fetch: (async () => new Response('{}', {
      status: 403, headers: { 'x-request-id': id },
    })) as typeof fetch });
    await assert.rejects(oauth.requestTokens({ grant_type: 'test' }), (error: unknown) => {
      assert.ok(error instanceof PlanAuthError);
      assert.ok(!error.message.includes(id));
      assert.ok(!error.message.includes('请求 ID'));
      return true;
    });
  }
});

test('jose validates signature, issuer, audience, expiry, nonce, subject and authorized party', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey); jwk.kid = 'offline-test';
  const verify = createIdentityVerifier(createLocalJWKSet({ keys: [jwk] }));
  const base = { iss: OPENAI_OIDC.issuer, aud: 'issued-client', sub: 'test-subject', nonce: 'nonce', iat: now / 1000, exp: now / 1000 + 3600 };
  const sign = (payload: object) => new SignJWT(payload).setProtectedHeader({ alg: 'RS256', kid: 'offline-test' }).sign(privateKey);
  const expected = { clientId: 'issued-client', nonce: 'nonce', subject: 'test-subject', now };
  assert.deepEqual(await verify(await sign(base), expected), { subject: 'test-subject' });
  for (const override of [{ iss: 'https://evil.invalid' }, { aud: 'wrong' }, { exp: now / 1000 - 10 }, { nonce: 'wrong' }, { sub: 'other' }, { iat: now / 1000 + 60 }, { aud: ['issued-client', 'other'] }, { azp: 'other' }]) {
    await assert.rejects(verify(await sign({ ...base, ...override }), expected), PlanAuthError);
  }
  const { privateKey: otherKey } = await generateKeyPair('RS256');
  await assert.rejects(verify(await new SignJWT(base).setProtectedHeader({ alg: 'RS256', kid: 'offline-test' }).sign(otherKey), expected), PlanAuthError);
});

function memoryStore(initial: PlanProfile | null) {
  let value = initial; let pending = Promise.resolve(); const writes: PlanProfile[] = [];
  return {
    writes, read: async () => value,
    async write(replacement: PlanProfile) { writes.push(replacement); value = replacement; },
    async withLock<T>(callback: () => Promise<T>): Promise<T> {
      const before = pending; let release = () => {}; pending = new Promise<void>(resolve => { release = resolve; });
      await before; try { return await callback(); } finally { release(); }
    },
    prepareRuntimeHome: async () => 'isolated-test-home',
  };
}

test('status never refreshes; concurrent tasks share one serialized rotating refresh and atomic token set', async () => {
  const store = memoryStore(profile({ expiresAt: now - 1 })); const f = fixture();
  const provider = new StoredPlanCredentialProvider(store, f.oauth, () => now);
  assert.equal((await provider.inspect()).authenticated, true); assert.equal(f.calls.length, 0);
  await assert.rejects(provider.acquire(false), PlanAuthError); assert.equal(f.calls.length, 0);
  const [a, b] = await Promise.all([provider.acquire(true), provider.acquire(true)]);
  assert.equal(f.calls.length, 1); assert.equal(a.revision, b.revision); assert.equal(store.writes.length, 1);
  assert.equal(store.writes[0]!.accessToken, 'new-access'); assert.equal(store.writes[0]!.refreshToken, 'new-refresh');
  const body = f.calls[0]!.body;
  assert.equal(body.get('grant_type'), 'refresh_token'); assert.equal(body.get('client_id'), 'issued-client'); assert.equal(body.has('scope'), false);
});

test('invalid refresh identity, network failure, cancellation and absent auth do not replace credentials', async () => {
  for (const oauth of [
    new PlanOAuth({ fetch: (async () => { throw new Error('secret-token'); }) as typeof fetch }),
    fixture({ verify: async () => { throw new PlanAuthError('invalid_response', '身份不匹配。'); } }).oauth,
  ]) {
    const store = memoryStore(profile({ expiresAt: now - 1 })); const provider = new StoredPlanCredentialProvider(store, oauth, () => now);
    await assert.rejects(provider.acquire(true), PlanAuthError); assert.equal(store.writes.length, 0);
  }
  const store = memoryStore(null); const f = fixture(); const provider = new StoredPlanCredentialProvider(store, f.oauth, () => now);
  assert.equal((await provider.inspect()).authenticated, false);
  await assert.rejects(provider.acquire(true), PlanAuthError); assert.equal(f.calls.length, 0);
  const cancelled = new AbortController(); cancelled.abort(); await assert.rejects(provider.acquire(true, cancelled.signal));
});

test('cancelling an in-flight rotating refresh saves its replacement before releasing the task', async () => {
  const store = memoryStore(profile({ expiresAt: now - 1 })); const controller = new AbortController();
  let started = () => {}; const inFlight = new Promise<void>(resolve => { started = resolve; });
  let release = () => {}; const responseGate = new Promise<void>(resolve => { release = resolve; });
  let tokenRequestSignal: AbortSignal | null | undefined;
  const oauth = new PlanOAuth({ now: () => now, verifyIdentity: async () => ({ subject: 'test-subject' }),
    fetch: (async (_url, init) => { tokenRequestSignal = init?.signal; started(); await responseGate; return new Response(JSON.stringify(tokens())); }) as typeof fetch,
  });
  const provider = new StoredPlanCredentialProvider(store, oauth, () => now);
  const acquiring = provider.acquire(true, controller.signal); void acquiring.catch(() => {});
  await inFlight; controller.abort(); assert.equal(tokenRequestSignal?.aborted, false);
  release(); await assert.rejects(acquiring, PlanAuthError);
  assert.equal(store.writes.length, 1); assert.equal(store.writes[0]!.refreshToken, 'new-refresh');
});

test('returning profiles keep their original app identity when display configuration changes', async () => {
  const f = fixture(); const oauth = new PlanOAuth({ appName: 'Renamed_Product', now: () => now,
    fetch: (async () => new Response(JSON.stringify(tokens()))) as typeof fetch,
    verifyIdentity: async (_id, expected) => { assert.equal(expected.subject, 'test-subject'); return { subject: 'test-subject' }; },
  });
  const attempt = oauth.begin(f.attempt.redirectUri, profile().hostId, profile());
  const auth = new URL(attempt.authorizationUrl); const callback = new URL(attempt.redirectUri);
  callback.search = new URLSearchParams({ code: 'test', state: auth.searchParams.get('state')! }).toString();
  assert.equal(auth.searchParams.has('agent_name_hint'), false);
  assert.equal((await attempt.complete(callback.toString())).appName, 'personal_agent');
});
