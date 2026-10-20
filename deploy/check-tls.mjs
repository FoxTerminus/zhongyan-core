import tls from 'node:tls';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';
import { isPublicHostname, isPublicIpv4 } from './tls-config.mjs';

export function certificateWindow(certificate, { now = Date.now(), minimumHours = 24 } = {}) {
  const notBefore = Date.parse(certificate.valid_from);
  const notAfter = Date.parse(certificate.valid_to);
  if (!Number.isFinite(notBefore) || !Number.isFinite(notAfter) || notAfter <= notBefore) {
    throw new Error('证书有效期无法读取。');
  }
  if (notBefore > now) throw new Error('证书尚未生效；检查主机时钟。');
  const remainingHours = (notAfter - now) / 3_600_000;
  if (remainingHours <= 0) throw new Error('证书已过期。');
  return { ok: remainingHours >= minimumHours, expiresAt: new Date(notAfter).toISOString(), remainingHours };
}

export function checkTls(host, { minimumHours = 24, timeoutMs = 10_000 } = {}) {
  if (!isPublicIpv4(host) && !isPublicHostname(host)) throw new Error('需要公开域名或公网 IPv4，不接受 URL、端口或内网地址。');
  if (!Number.isFinite(minimumHours) || minimumHours < 1 || minimumHours > 72) throw new Error('到期阈值必须在 1–72 小时之间。');
  return new Promise((resolve, reject) => {
    // No HTTP request, account token, client key, or ACME registration is sent.
    // IP clients omit SNI; this also exercises Caddy's default_sni configuration.
    const socket = tls.connect({
      host, port: 443, servername: isIP(host) ? undefined : host,
      rejectUnauthorized: true, minVersion: 'TLSv1.2',
      checkServerIdentity: (_servername, certificate) => tls.checkServerIdentity(host, certificate),
    });
    // A wall-clock deadline also covers DNS lookup and incomplete handshakes.
    const deadline = setTimeout(() => socket.destroy(new Error('TLS 连接超时。')), timeoutMs);
    socket.once('close', () => { clearTimeout(deadline); reject(new Error('TLS 连接在检查完成前关闭。')); });
    socket.once('error', error => reject(new Error(`TLS 握手或信任校验失败（${error.code || 'CONNECTION_ERROR'}）。`)));
    socket.once('secureConnect', () => {
      clearTimeout(deadline);
      try {
        if (!socket.authorized) throw new Error('TLS 证书未获系统信任。');
        resolve(certificateWindow(socket.getPeerCertificate(), { minimumHours }));
      } catch (error) { reject(error); }
      finally { socket.destroy(); }
    });
  });
}

async function main(args) {
  const usage = 'node deploy/check-tls.mjs --host <公网IPv4或域名> [--minimum-hours 24]\n显式指定目标才进行一次公网 TLS 握手；只检查证书，不发送连接密钥，不申请或更新证书。';
  if (!args.length || args.includes('--help')) { console.log(usage); return; }
  if (args[0] !== '--host' || !args[1] || ![2, 4].includes(args.length)
      || (args.length === 4 && args[2] !== '--minimum-hours')) throw new Error(usage);
  const report = await checkTls(args[1], { minimumHours: args[3] === undefined ? 24 : Number(args[3]) });
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
