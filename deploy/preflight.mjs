import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, readFile, statfs } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { getTlsConfigFromText } from './tls-config.mjs';

const run = promisify(execFile);
const directory = fileURLToPath(new URL('./', import.meta.url));
const checks = [];
const plan = process.argv.includes('--plan');
const record = (name, ok, detail) => checks.push({ name, ok, detail });

async function command(name, args, detail) {
  try {
    await run('docker', args, { cwd: directory, timeout: 15_000, maxBuffer: 256 * 1024, windowsHide: true });
    record(name, true, detail);
    return true;
  } catch {
    // Child output can contain resolved environment variables. Never echo it.
    record(name, false, `检查失败；在目标主机检查 Docker 安装、权限及配置（${name}）。`);
    return false;
  }
}

if (process.argv.includes('--help')) {
  console.log('node deploy/preflight.mjs [--json] [--plan]\n只读检查当前主机、Docker、磁盘与部署配置。不登录、不创建或启动资源，不输出密钥。请在目标 Linux 主机执行。--plan 额外检查运行器密钥和覆盖配置，不启用或授权模型。');
} else {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  record('node', nodeMajor >= 24, '需要 Node.js 24 或更新的兼容版本。');
  record('platform', process.platform === 'linux', '当前容器部署方案的目标主机为 Linux。');
  try {
    const disk = await statfs(directory, { bigint: true });
    const free = disk.bavail * disk.bsize;
    record('disk', free >= 6n * 1024n ** 3n, `工程所在磁盘可用约 ${Number(free / (1024n ** 3n))} GiB；预留至少 6 GiB 用于构建、镜像及数据。`);
  } catch {
    record('disk', false, '无法读取部署目录所在磁盘的可用空间。');
  }

  let envReady = false;
  try {
    const env = await readFile(new URL('deployment.env', import.meta.url), 'utf8');
    const tls = getTlsConfigFromText(env, process.env);
    envReady = true;
    record('hostname', true, tls.mode === 'ip'
      ? '公网 IPv4 配置格式通过；使用显式公共 ACME shortlived 证书，不使用本地 CA。尚未验证 IP 所有权、端口连通或证书签发。'
      : '公开域名配置格式通过；此检查不证明 DNS 已解析。');
  } catch {
    record('hostname', false, 'deploy/deployment.env 缺失或 TLS 配置无效；填写 AGENT_DOMAIN，并用 AGENT_TLS_MODE=domain|ip 选择匹配的地址类型。');
  }

  const secrets = plan
    ? [['secret', 'agent-auth-token'], ['runner-secret', 'runner-auth-token']]
    : [['secret', 'agent-auth-token']];
  for (const [name, filename] of secrets) {
    try {
      const dir = await lstat(new URL('.secrets/', import.meta.url));
      const secret = await lstat(new URL(`.secrets/${filename}`, import.meta.url));
      const modesSafe = process.platform === 'linux' && (dir.mode & 0o077) === 0 && (secret.mode & 0o022) === 0;
      record(name, dir.isDirectory() && !dir.isSymbolicLink() && secret.isFile() && !secret.isSymbolicLink() && secret.size >= 32 && modesSafe,
        '仅检查密钥文件元数据：目录必须 0700、文件不可被其他用户写入且不能是链接；内容未读取。');
    } catch {
      record(name, false, `${filename} 尚未准备好；在目标主机运行 node deploy/prepare.mjs。`);
    }
  }
  const docker = await command('docker', ['version', '--format', '{{.Server.Version}}'], 'Docker 守护进程可访问。');
  if (docker) {
    const compose = await command('compose', ['compose', 'version', '--short'], 'Docker Compose 可用。');
    if (compose && envReady) {
      await command('compose-config', ['compose', '--env-file', 'deployment.env', '-f', 'compose.yaml', ...(plan ? ['-f', 'compose.plan.yaml'] : []), 'config', '--quiet'], 'Compose 配置通过解析。');
    }
  }
  const report = {
    ok: checks.every(check => check.ok),
    profile: plan ? 'plan' : 'base',
    checks,
    limitations: [
      '这是部署前检查，不代表已完成容器构建、HTTPS 签发、备份恢复或真实手机联通。',
      plan
        ? '仅检查显式 plan 覆盖配置；不启动运行器、不登录 ChatGPT，不证明模型授权或调用可用。'
        : '当前 compose 默认禁用模型且无运行器外网连接；本检查不会启用模型、工具或 ChatGPT 授权。',
    ],
  };
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    for (const check of checks) console.log(`${check.ok ? '通过' : '待处理'} ${check.name}: ${check.detail}`);
    for (const limitation of report.limitations) console.log(limitation);
  }
  if (!report.ok) process.exitCode = 1;
}
