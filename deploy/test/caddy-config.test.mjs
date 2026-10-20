import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// Opt in with a trusted, locally downloaded binary. Adapt only: never run,
// validate/provision, request a certificate, or contact the sample address.
const binary = process.env.CADDY_BIN;
const directory = fileURLToPath(new URL('../', import.meta.url));
function adapt(filename, host) {
  const run = spawnSync(binary, ['adapt', '--adapter', 'caddyfile', '--config', filename], {
    cwd: directory, env: { ...process.env, AGENT_DOMAIN: host },
    encoding: 'utf8', timeout: 10_000, maxBuffer: 256 * 1024, windowsHide: true,
  });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}
function objects(value) {
  if (!value || typeof value !== 'object') return [];
  return [value, ...Object.values(value).flatMap(objects)];
}
function assertRouting(config, host) {
  assert.equal(config.admin.disabled, true);
  const all = objects(config);
  const proxy = all.filter(value => value.handler === 'reverse_proxy');
  assert.equal(proxy.length, 1);
  assert.equal(proxy[0].flush_interval, -1);
  assert.deepEqual(proxy[0].upstreams, [{ dial: 'server:8787' }]);
  const redirect = all.find(value => value.status_code === 301);
  assert.deepEqual(redirect.headers.Location, [`https://${host}{http.request.uri}`]);
  assert.ok(!redirect.headers.Location[0].includes(':8443'));
  assert.deepEqual(Object.values(config.apps.http.servers).flatMap(value => value.listen).sort(), [':8080', ':8443']);
}

test('IP template explicitly selects the public CA and profile; both templates ship in the image', async () => {
  const ip = await readFile(new URL('../Caddyfile.ip', import.meta.url), 'utf8');
  assert.match(ip, /default_sni \{\$AGENT_DOMAIN\}/);
  assert.match(ip, /dir https:\/\/acme-v02\.api\.letsencrypt\.org\/directory/);
  assert.match(ip, /profile shortlived/);
  assert.doesNotMatch(ip, /\btls\s+internal\b|\bissuer\s+internal\b|\blocal_certs\b/);
  const docker = await readFile(new URL('../Caddy.Dockerfile', import.meta.url), 'utf8');
  const ignore = await readFile(new URL('../Caddy.Dockerfile.dockerignore', import.meta.url), 'utf8');
  assert.match(docker, /COPY deploy\/Caddyfile \/etc\/caddy\/Caddyfile\.domain/);
  assert.match(docker, /COPY deploy\/Caddyfile\.ip \/etc\/caddy\/Caddyfile\.ip/);
  assert.match(ignore, /!deploy\/Caddyfile\.ip/);
});

test('real Caddy adapt: IPv4 issuer, no-SNI selection, challenge ports and public redirects', { skip: !binary && 'Set CADDY_BIN to run offline Caddy parser verification.' }, () => {
  const config = adapt('Caddyfile.ip', '8.8.8.8');
  assertRouting(config, '8.8.8.8');
  const policies = config.apps.tls.automation.policies;
  assert.equal(policies.length, 1);
  assert.deepEqual(policies[0].subjects, ['8.8.8.8']);
  assert.equal(policies[0].issuers.length, 1);
  const issuer = policies[0].issuers[0];
  assert.equal(issuer.module, 'acme');
  assert.equal(issuer.ca, 'https://acme-v02.api.letsencrypt.org/directory');
  assert.equal(issuer.profile, 'shortlived');
  assert.equal(issuer.challenges.http.alternate_port, 8080);
  assert.equal(issuer.challenges['tls-alpn'].alternate_port, 8443);
  const https = Object.values(config.apps.http.servers).find(value => value.listen.includes(':8443'));
  assert.ok(https.tls_connection_policies.length > 0);
  for (const policy of https.tls_connection_policies) assert.equal(policy.default_sni, '8.8.8.8');
});

test('real Caddy adapt: existing domain mode remains usable without an IP profile', { skip: !binary && 'Set CADDY_BIN to run offline Caddy parser verification.' }, () => {
  const config = adapt('Caddyfile', 'agent.my-domain.com');
  assertRouting(config, 'agent.my-domain.com');
  assert.ok(!objects(config).some(value => value.module === 'internal' || value.profile === 'shortlived'));
});
