import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, mkdir, realpath, statfs, readFile } from 'node:fs/promises';
import { resolve, dirname, parse, join } from 'node:path';

export const VOLUMES = ['agent_data', 'runner_state', 'runner_workspace', 'caddy_data', 'caddy_config'];
export const SERVICES = ['runner', 'server', 'proxy'];
export const CONFIG_FILES = ['deployment.env', '.secrets/agent-auth-token', '.secrets/runner-auth-token', 'compose.yaml', 'compose.plan.yaml'];
export class OperationsError extends Error {}
export function requireLinuxRoot() {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) throw new OperationsError('请在目标 Linux 主机以 root 运行；支持 rootful Docker 本地卷。');
}
export async function command(executable, args, timeout = 30_000, signal) {
  try { return (await promisify(execFile)(executable, args, { timeout, signal, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024 })).stdout.trim(); }
  catch (error) {
    const detail = Number.isInteger(error.code) ? '（退出码 ' + error.code + '）'
      : typeof error.signal === 'string' && /^SIG[A-Z0-9]+$/.test(error.signal) ? '（终止信号 ' + error.signal + '）' : '';
    throw new OperationsError('运维命令失败：' + executable + detail + '。未输出参数或原始日志；请检查工具、权限与服务状态。');
  }
}
/** Keep cleanup alive after cancellation; only the active work receives the abort signal. */
export async function withCancellation(action, events = process) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const check = () => { if (controller.signal.aborted) throw new OperationsError('恢复已取消；未修改线上服务，请检查隔离副本。'); };
  events.on('SIGINT', cancel); events.on('SIGTERM', cancel);
  try { return await action(controller.signal, check); }
  finally { events.removeListener('SIGINT', cancel); events.removeListener('SIGTERM', cancel); }
}
export async function realDirectory(path) {
  const absolute = resolve(path);
  if (absolute === parse(absolute).root || await realpath(absolute) !== absolute || !(await lstat(absolute)).isDirectory()) throw new OperationsError('需要真实非根目录，不能使用符号链接。');
  return absolute;
}
export function checkPrivateDirectoryOwner(stat, ownerUid) {
  if (!Number.isSafeInteger(ownerUid) || ownerUid < 0 || (stat.mode & 0o777) !== 0o700 || stat.uid !== ownerUid) {
    throw new OperationsError('受保护目录必须属于指定用户且权限为 0700。');
  }
}
export async function privateDirectory(path, { ownerUid = process.getuid?.() } = {}) {
  const absolute = await realDirectory(path);
  const stat = await lstat(absolute);
  if (process.platform !== 'win32') checkPrivateDirectoryOwner(stat, ownerUid);
  return absolute;
}
export async function createPrivateDirectory(path) {
  const absolute = resolve(path);
  await privateDirectory(dirname(absolute));
  // No recursive mkdir and no reuse: never overwrite a previous backup/restore.
  await mkdir(absolute, { mode: 0o700 });
  return privateDirectory(absolute);
}
export async function ordinaryFile(path, maximumBytes = Infinity) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maximumBytes) throw new OperationsError('需要大小受限、非链接的普通文件。');
  return stat;
}
export async function checkSpace(path, requiredBytes) {
  if (!Number.isSafeInteger(requiredBytes) || requiredBytes < 0) throw new OperationsError('磁盘空间需求超出支持范围。');
  const stat = await statfs(path, { bigint: true });
  if (stat.bavail * stat.bsize < BigInt(requiredBytes)) throw new OperationsError('目标磁盘可用空间不足，未开始停服或恢复。');
}
export async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export function compose(root, args) {
  return ['compose', '--env-file', join(root, 'deploy/deployment.env'), '-f', join(root, 'deploy/compose.yaml'), '-f', join(root, 'deploy/compose.plan.yaml'), ...args];
}
export async function discovery(root, run = command) {
  const config = JSON.parse(await run('docker', compose(root, ['config', '--format', 'json'])));
  if (Object.keys(config.volumes ?? {}).sort().join(',') !== [...VOLUMES].sort().join(',')) throw new OperationsError('持久卷布局已变化；请先更新备份范围，避免遗漏。');
  const volumes = [];
  for (const logical of VOLUMES) {
    const name = config.volumes[logical].name;
    if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(name)) throw new OperationsError('无法确定 Compose 持久卷。');
    const path = JSON.parse(await run('docker', ['volume', 'inspect', '--format', '{{json .Mountpoint}}', name]));
    volumes.push({ logical, name, path: await realDirectory(path) });
  }
  const services = [];
  for (const service of SERVICES) {
    const id = await run('docker', compose(root, ['ps', '--all', '--quiet', service]));
    if (!/^[a-f0-9]{12,64}$/.test(id)) throw new OperationsError('备份需要每个服务恰有一个已有容器；不会自动创建。');
    const value = JSON.parse(await run('docker', ['inspect', '--format', '{"running":{{json .State.Running}},"image":{{json .Image}}}', id]));
    services.push({ service, id, running: value.running === true, image: value.image });
  }
  return { services, volumes };
}
/** Never collect binary output or raw subprocess errors in memory/logs. */
export async function encryptedArchive(stage, output, recipientFile, timeout = 600_000) {
  const tar = spawn('tar', ['-czf', '-', '-C', stage, '.'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const age = spawn('age', ['-R', recipientFile, '-o', output], { stdio: ['pipe', 'ignore', 'ignore'] });
  const children = [tar, age];
  const stop = () => children.forEach(child => child.kill('SIGKILL'));
  const timer = setTimeout(stop, timeout);
  const exited = child => new Promise((done, fail) => {
    child.once('error', () => fail(new OperationsError('无法启动归档或加密工具。')));
    child.once('exit', code => code === 0 ? done() : fail(new OperationsError('加密归档失败，未生成可恢复备份。')));
  });
  try { await Promise.all([exited(tar), exited(age), pipeline(tar.stdout, age.stdin)]); }
  catch { stop(); throw new OperationsError('加密归档失败，未生成可恢复备份。'); }
  finally { clearTimeout(timer); }
}
export async function recipient(path) {
  await ordinaryFile(path, 4096);
  const value = (await readFile(path, 'utf8')).trim();
  if (!/^age1[0-9a-z]{58}$/.test(value)) throw new OperationsError('公钥文件应只包含一枚 age X25519 公钥，不接收私钥或口令。');
}
