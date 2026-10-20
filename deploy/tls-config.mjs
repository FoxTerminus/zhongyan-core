import { isIPv4 } from 'node:net';
import { parseEnv } from 'node:util';

// These special-purpose ranges cannot be an ordinary public cloud VM address.
// Keep this conservative list with the IANA registry; this does not prove ownership.
const excludedIpv4Ranges = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
const ipv4Number = value => value.split('.').reduce((result, part) => result * 256 + Number(part), 0);

export function isPublicIpv4(value) {
  if (typeof value !== 'string' || !isIPv4(value)) return false;
  const number = ipv4Number(value);
  return !excludedIpv4Ranges.some(([network, prefix]) =>
    Math.floor(number / 2 ** (32 - prefix)) === Math.floor(ipv4Number(network) / 2 ** (32 - prefix)));
}

export function isPublicHostname(value) {
  if (typeof value !== 'string' || value.length > 253 || !value.includes('.')) return false;
  const labels = value.split('.');
  if (!labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) return false;
  // Numeric forms must not masquerade as DNS names, including shortened IPv4.
  if (!/^[a-z]/i.test(labels.at(-1))) return false;
  const lower = value.toLowerCase();
  return !['localhost', 'local', 'internal', 'test', 'invalid', 'example', 'home.arpa',
    'example.com', 'example.net', 'example.org'].some(suffix => lower === suffix || lower.endsWith(`.${suffix}`));
}

export function getTlsConfig(environment) {
  const mode = environment.AGENT_TLS_MODE || 'domain';
  const host = environment.AGENT_DOMAIN || '';
  if (!['domain', 'ip'].includes(mode)) throw new Error('AGENT_TLS_MODE 必须为 domain 或 ip。');
  if (mode === 'ip' && !isPublicIpv4(host)) {
    throw new Error('IP 模式需要服务器实际公网 IPv4；不接受内网、回环、文档示例地址、URL 或端口。');
  }
  if (mode === 'domain' && !isPublicHostname(host)) {
    throw new Error('域名模式需要公开域名；裸 IPv4 请显式选择 AGENT_TLS_MODE=ip。');
  }
  return { mode, host, caddyfile: `/etc/caddy/Caddyfile.${mode}` };
}

// Match Compose's shell-over-file precedence, without logging either environment.
export function getTlsConfigFromText(text, overrides = {}) {
  const environment = parseEnv(text);
  for (const key of ['AGENT_TLS_MODE', 'AGENT_DOMAIN']) {
    if (Object.hasOwn(overrides, key)) environment[key] = overrides[key];
  }
  return getTlsConfig(environment);
}
