import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { command, compose, SERVICES, OperationsError, checkSpace } from './operations.mjs';
import { getTlsConfigFromText } from './tls-config.mjs';
import { checkTls } from './check-tls.mjs';

export function healthyContainer(value, requireHealthcheck) {
  return value?.running === true && (!requireHealthcheck || value.health === 'healthy');
}
export async function checkHealth(rootValue, dependencies = {}) {
  const run = dependencies.command ?? command;
  const tlsProbe = dependencies.tls ?? checkTls;
  const transport = dependencies.fetch ?? fetch;
  const space = dependencies.space ?? checkSpace;
  const root = resolve(rootValue);
  const checks = [];
  const record = async (name, callback) => {
    try { const detail = await callback(); checks.push({ name, ok: true, detail }); }
    catch { checks.push({ name, ok: false, detail: '检查失败；未输出原始响应或环境配置。' }); }
  };
  await record('disk', async () => { await space(root, 2 * 1024 ** 3); return '可用空间至少 2 GiB。'; });
  for (const service of SERVICES) await record(service, async () => {
    const id = await run('docker', compose(root, ['ps', '--all', '--quiet', service]));
    if (!/^[a-f0-9]{12,64}$/.test(id)) throw new OperationsError('服务容器数量无效。');
    const value = JSON.parse(await run('docker', ['inspect', '--format', '{"running":{{json .State.Running}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}}}', id]));
    if (!healthyContainer(value, service !== 'proxy')) throw new OperationsError('服务未就绪。');
    return service === 'proxy' ? '代理进程运行。' : '容器健康检查通过。';
  });
  let tls;
  await record('address', async () => {
    tls = getTlsConfigFromText(await readFile(join(root, 'deploy/deployment.env'), 'utf8'), process.env);
    return '公网地址与 TLS 模式配置有效。';
  });
  if (tls) {
    await record('certificate', async () => {
      const certificate = await tlsProbe(tls.host, { minimumHours: 24 });
      if (!certificate.ok) throw new OperationsError('证书临期。');
      return { expiresAt: certificate.expiresAt, remainingHours: Math.floor(certificate.remainingHours) };
    });
    await record('https-api', async () => {
      const response = await transport('https://' + tls.host + '/health', { redirect: 'error', signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new OperationsError('HTTPS 接口未就绪。');
      if (!response.body) throw new OperationsError('缺少健康响应。');
      const reader = response.body.getReader();
      const chunks = []; let bytes = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.length;
          if (bytes > 4096) throw new OperationsError('响应过大。');
          chunks.push(part.value);
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (value.status !== 'ok' || value.protocolVersion !== 1) throw new OperationsError('健康响应不兼容。');
      return 'HTTPS /health 及协议版本正常。';
    });
  }
  return { ok: checks.every(check => check.ok), checkedAt: new Date().toISOString(), checks,
    limitations: ['未使用设备密钥，不读取或刷新 ChatGPT 授权，不调用模型；不能代替真实任务验收。',
      '服务器自身探测不能证明手机网络连通；证书续期故障需同时检查外部连通性。'] };
}
async function main() {
  const { values } = parseArgs({ options: { help: { type: 'boolean' }, root: { type: 'string' } } });
  if (values.help) { console.log('node deploy/check-health.mjs [--root <源码目录>]\n只读检查三服务、磁盘、公共证书与 /health，不调用模型。失败返回非零；不自动重启或修复。'); return; }
  const report = await checkHealth(values.root ?? process.cwd());
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => {
  console.error('健康检查未完成；请检查参数、目标目录与运行权限。'); process.exitCode = 1;
});
