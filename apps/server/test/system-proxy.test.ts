import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { promisify } from 'node:util';
import type { AddressInfo } from 'node:net';
import { createSystemProxyEnvironment } from '../src/auth/system-proxy.js';
import { OPENAI_OIDC, PlanAuthError } from '../src/auth/types.js';

const execFileAsync = promisify(execFile);
const fixture = (readProxy: (url: string) => Promise<string | null>) => ({
  platform: 'win32' as const, proxyFlagSupported: true, readProxy,
});

test('system proxy is resolved for the fixed auth endpoint and confined to a copied child environment', async () => {
  const environment = {
    PATH: 'test-path', APP_SETTING: 'preserved',
    HTTP_PROXY: 'old', https_proxy: 'old', HtTp_PrOxY: 'old',
    ALL_PROXY: 'old', all_proxy: 'old', no_proxy: '*', NO_PROXY: 'auth.openai.com',
    node_use_env_proxy: '0', NODE_USE_ENV_PROXY: '0',
  };
  const original = { ...environment };
  const currentProcess = JSON.stringify(process.env);
  const calls: string[] = [];
  const result = await createSystemProxyEnvironment({
    env: environment, ...fixture(async url => { calls.push(url); return 'http://127.0.0.1:10001'; }),
  });
  assert.deepEqual(calls, [OPENAI_OIDC.token]);
  assert.deepEqual(environment, original);
  // Compare only a boolean so a failed assertion can never print process secrets.
  assert.equal(JSON.stringify(process.env) === currentProcess, true, 'The current process environment must stay unchanged');
  assert.notEqual(result, environment);
  assert.deepEqual(result, {
    PATH: 'test-path', APP_SETTING: 'preserved',
    HTTP_PROXY: 'http://127.0.0.1:10001/', HTTPS_PROXY: 'http://127.0.0.1:10001/',
    NODE_USE_ENV_PROXY: '1', NO_PROXY: '127.0.0.1,localhost,::1,[::1]',
  });
});

test('system proxy rejects direct, malformed, credential-bearing and unsupported results without revealing them', async () => {
  for (const value of [
    null, '', ' ', 'not-a-url', 'socks5://127.0.0.1:10001',
    'http://private-user:private-password@127.0.0.1:10001',
    'http://private-user@127.0.0.1:10001', 'http://127.0.0.1:10001/private-path',
    'http://127.0.0.1:10001/?private-query', 'http://127.0.0.1:10001/#private-fragment',
    ' http://127.0.0.1:10001', 'http://127.0.0.1:10001\n', 'a'.repeat(2049),
  ]) {
    await assert.rejects(createSystemProxyEnvironment({ env: {}, ...fixture(async () => value) }), error =>
      error instanceof PlanAuthError && error.code === 'configuration'
      && !error.message.includes('private') && !error.message.includes('10001'));
  }
  await assert.rejects(createSystemProxyEnvironment({
    env: {}, ...fixture(async () => { throw new Error('private-settings-and-credentials'); }),
  }), error => error instanceof PlanAuthError && !error.message.includes('private'));
});

test('platform and runtime capabilities fail before accessing system settings', async () => {
  let calls = 0;
  const options = { env: {}, ...fixture(async () => { calls++; return 'http://127.0.0.1:10001'; }) };
  await assert.rejects(createSystemProxyEnvironment({ ...options, platform: 'linux' }), error =>
    error instanceof PlanAuthError && error.message.includes('Windows'));
  await assert.rejects(createSystemProxyEnvironment({ ...options, proxyFlagSupported: false }), error =>
    error instanceof PlanAuthError && error.message.includes('--use-env-proxy'));
  assert.equal(calls, 0);
});

test('HTTPS proxy addresses are accepted without changing their transport scheme', async () => {
  const result = await createSystemProxyEnvironment({
    env: {}, ...fixture(async () => 'https://proxy.example:8443'),
  });
  assert.equal(result.HTTPS_PROXY, 'https://proxy.example:8443/');
});

test('Node proxy mode routes fetch and jose JWKS through a local CONNECT proxy while bypassing loopback callbacks', {
  skip: !process.allowedNodeEnvironmentFlags.has('--use-env-proxy'),
}, async () => {
  const targets: string[] = [];
  const proxy = createServer((_request, response) => {
    response.writeHead(502); response.end('Unexpected plain proxy request');
  });
  proxy.on('connect', (request, socket) => {
    targets.push(request.url ?? '');
    // Deliberately do not connect onward: every socket in this test is local.
    socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  const direct = createServer((_request, response) => { response.end('direct-loopback'); });
  proxy.listen(0, '127.0.0.1'); direct.listen(0, '127.0.0.1');
  await Promise.all([once(proxy, 'listening'), once(direct, 'listening')]);
  try {
    const proxyPort = (proxy.address() as AddressInfo).port;
    const directPort = (direct.address() as AddressInfo).port;
    const env = await createSystemProxyEnvironment({
      env: process.env, ...fixture(async () => `http://127.0.0.1:${proxyPort}`),
    });
    const script = `
      import { createRemoteJWKSet } from 'jose';
      let rejected = 0;
      try { await fetch('https://127.0.0.2/token', { signal: AbortSignal.timeout(2000) }); }
      catch { rejected++; }
      try { await createRemoteJWKSet(new URL('https://127.0.0.3/jwks'), { timeoutDuration: 2000 })({ alg: 'RS256', kid: 'offline-test' }, {}); }
      catch { rejected++; }
      const direct = await fetch('http://127.0.0.1:${directPort}/callback', { signal: AbortSignal.timeout(2000) });
      console.log(JSON.stringify({ rejected, direct: await direct.text() }));
    `;
    const { stdout } = await execFileAsync(process.execPath, ['--use-env-proxy', '--input-type=module', '-e', script], {
      env, timeout: 10_000, windowsHide: true, maxBuffer: 4096,
    });
    assert.deepEqual(JSON.parse(stdout.trim()), { rejected: 2, direct: 'direct-loopback' });
    assert.deepEqual(targets.sort(), ['127.0.0.2:443', '127.0.0.3:443']);
  } finally {
    proxy.closeAllConnections(); direct.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => proxy.close(() => resolve())), new Promise<void>(resolve => direct.close(() => resolve()))]);
  }
});
