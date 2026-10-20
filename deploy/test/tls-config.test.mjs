import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { getTlsConfig, getTlsConfigFromText, isPublicIpv4 } from '../tls-config.mjs';
import { certificateWindow, checkTls } from '../check-tls.mjs';

test('domain remains the compatible default; IP mode is explicit', () => {
  assert.deepEqual(getTlsConfig({ AGENT_DOMAIN: 'agent.my-domain.com' }), {
    mode: 'domain', host: 'agent.my-domain.com', caddyfile: '/etc/caddy/Caddyfile.domain',
  });
  assert.deepEqual(getTlsConfig({ AGENT_DOMAIN: '8.8.8.8', AGENT_TLS_MODE: 'ip' }), {
    mode: 'ip', host: '8.8.8.8', caddyfile: '/etc/caddy/Caddyfile.ip',
  });
  assert.throws(() => getTlsConfig({ AGENT_DOMAIN: '8.8.8.8' }));
  assert.throws(() => getTlsConfig({ AGENT_DOMAIN: 'agent.my-domain.com', AGENT_TLS_MODE: 'ip' }));
  assert.throws(() => getTlsConfig({ AGENT_DOMAIN: 'agent.my-domain.com', AGENT_TLS_MODE: '../ip' }));
});

test('reject private, special, malformed and document-example IPv4 before any ACME work', () => {
  for (const host of ['0.0.0.0', '10.20.30.40', '100.64.0.1', '100.127.255.255', '127.0.0.1',
    '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.0.0.1', '192.0.2.1', '192.168.1.1',
    '198.18.0.1', '198.19.255.255', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255',
    '8.8.8.08', '1.2.3', '256.1.1.1', '::1', 'https://8.8.8.8', '8.8.8.8:443', '8.8.8.8\n{']) {
    assert.equal(isPublicIpv4(host), false, host);
  }
  for (const host of ['8.8.8.8', '1.1.1.1', '100.128.0.1', '172.32.0.1', '198.20.0.1']) {
    assert.equal(isPublicIpv4(host), true, host);
  }
});

test('hostnames cannot inject Caddy tokens or silently select local CA', () => {
  for (const host of ['', 'localhost', 'agent.local', 'agent.test', 'home.arpa', 'example.com',
    '127.1', '2130706433', 'agent..com', '-agent.com', 'agent-.com', 'agent.com:443',
    'https://agent.com', 'agent.com/path', 'agent.com\nimport x', '{$HOST}', '*.agent.com',
    `${'a'.repeat(64)}.com`]) assert.throws(() => getTlsConfig({ AGENT_DOMAIN: host }), host);
});

test('quoted env and shell precedence match the effective TLS choice without DNS lookups', () => {
  assert.equal(getTlsConfigFromText('AGENT_TLS_MODE="ip"\nAGENT_DOMAIN="8.8.8.8"\n').mode, 'ip');
  assert.throws(() => getTlsConfigFromText('AGENT_TLS_MODE=ip\nAGENT_DOMAIN=8.8.8.8', { AGENT_DOMAIN: '127.0.0.1' }));
});

test('expiration monitoring handles threshold, expired and not-yet-valid certificates', () => {
  const now = Date.parse('2026-10-20T00:00:00Z');
  const cert = until => ({ valid_from: '2026-10-19T00:00:00Z', valid_to: until });
  assert.equal(certificateWindow(cert('2026-10-21T00:00:00Z'), { now }).ok, true);
  assert.equal(certificateWindow(cert('2026-10-20T23:59:59Z'), { now }).ok, false);
  assert.throws(() => certificateWindow(cert('2026-10-20T00:00:00Z'), { now }), /过期/);
  assert.throws(() => certificateWindow({ valid_from: '2026-10-21', valid_to: '2026-10-22' }, { now }), /尚未生效/);
  assert.throws(() => certificateWindow({ valid_from: 'bad', valid_to: 'bad' }, { now }));
});

test('TLS checker has no implicit network target and rejects unsafe arguments synchronously', () => {
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('../check-tls.mjs', import.meta.url))], { encoding: 'utf8', timeout: 5_000, windowsHide: true });
  assert.equal(run.status, 0);
  assert.match(run.stdout, /显式指定目标/);
  assert.throws(() => checkTls('127.0.0.1'));
  assert.throws(() => checkTls('8.8.8.8', { minimumHours: NaN }));
  assert.throws(() => checkTls('8.8.8.8', { minimumHours: 0 }));
});
