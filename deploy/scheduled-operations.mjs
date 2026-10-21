import { readFile, writeFile, mkdir, rename, unlink, rmdir, readdir, lstat, chmod } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { backupDeployment } from './backup.mjs';
import { checkHealth } from './check-health.mjs';
import { validateManifest } from './restore.mjs';
import { requireLinuxRoot, realDirectory, privateDirectory, ordinaryFile, digest, command, compose, OperationsError } from './operations.mjs';

const AUTO_NAME = /^auto-v1-\d{8}T\d{6}Z-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const GATE_MS = 15 * 60_000;
const stamp = now => new Date(now).toISOString();
export function backupDue(lastSuccessAt, now, hourUtc = 20, minuteUtc = 30) {
  const slot = new Date(now); slot.setUTCHours(hourUtc, minuteUtc, 0, 0);
  if (slot.getTime() > now) slot.setUTCDate(slot.getUTCDate() - 1);
  if (!lastSuccessAt) return true;
  const success = Date.parse(lastSuccessAt);
  if (!Number.isFinite(success) || success > now + 60_000) throw new OperationsError('备份时间状态无效，需管理员检查。');
  return success < slot.getTime();
}
export function maintenanceIdle(value, operationId, now = Date.now()) {
  return value?.schemaVersion === 1 && value.maintenance?.active === true && value.maintenance?.operationId === operationId
    && Date.parse(value.maintenance?.expiresAt) >= now + 120_000
    && value.idle?.queued === 0 && value.idle?.running === 0 && value.idle?.workerBusy === false;
}
export async function atomicJson(directory, name, value) {
  if (!['health.json', 'backup.json', 'maintenance.json'].includes(name)) throw new OperationsError('未知运维状态文件。');
  const path = join(directory, name), temporary = join(directory, '.' + name + '-' + randomUUID() + '.tmp');
  try {
    try { await ordinaryFile(path, 64 * 1024); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await writeFile(temporary, JSON.stringify(value) + '\n', { mode: 0o644, flag: 'wx' });
    await chmod(temporary, 0o644); // Public, sanitized state is readable by the unprivileged API container.
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
async function state(directory, name) {
  try {
    await ordinaryFile(join(directory, name), 64 * 1024);
    const value = JSON.parse(await readFile(join(directory, name), 'utf8'));
    if (value?.schemaVersion !== 1) throw new OperationsError('运维状态版本无效。');
    return value;
  } catch (error) { if (error.code === 'ENOENT') return null; throw new OperationsError('运维状态损坏；未覆盖历史成功记录。'); }
}
export async function exclusive(directory, name, action) {
  const lock = join(directory, name);
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') return { ok: false, status: 'locked' }; throw error; }
  try { return await action(); } finally { await rmdir(lock); }
}
export async function loadConfig(file) {
  requireLinuxRoot();
  const stat = await ordinaryFile(file, 16 * 1024);
  if (stat.uid !== 0 || (stat.mode & 0o022) !== 0) throw new OperationsError('调度配置须为 root 所有且不能由其他用户写入。');
  const value = JSON.parse(await readFile(file, 'utf8'));
  if (value.schemaVersion !== 1) throw new OperationsError('调度配置版本无效。');
  for (const key of ['root', 'stateDirectory', 'backupDirectory', 'recipient']) {
    if (typeof value[key] !== 'string' || value[key] !== resolve(value[key])) throw new OperationsError('调度路径须为绝对路径。');
  }
  await realDirectory(value.root);
  await privateDirectory(value.backupDirectory);
  await realDirectory(value.stateDirectory);
  const publicStat = await lstat(value.stateDirectory);
  if (publicStat.uid !== 0 || (publicStat.mode & 0o777) !== 0o755) throw new OperationsError('公开运维状态目录须为 root 所有且权限0755。');
  const hourUtc = value.hourUtc ?? 20, minuteUtc = value.minuteUtc ?? 30;
  if (!Number.isInteger(hourUtc) || hourUtc < 0 || hourUtc > 23 || !Number.isInteger(minuteUtc) || minuteUtc < 0 || minuteUtc > 59) throw new OperationsError('备份时刻无效。');
  return { ...value, hourUtc, minuteUtc, retention: 7 };
}

/** This fixed program executes inside the existing server; no profile/token is returned. */
export const IDLE_PROGRAM = `
import { readFile } from 'node:fs/promises';
try {
  const token = (await readFile(process.env.AGENT_AUTH_TOKEN_FILE, 'utf8')).trim();
  const response = await fetch('http://127.0.0.1:8787/v1/operations', {headers:{Authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(8000)});
  if(!response.ok) throw new Error();
  const reader=response.body.getReader(); const chunks=[]; let bytes=0;
  try { for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.length;if(bytes>65536)throw new Error();chunks.push(part.value);} }
  finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
  const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  console.log(JSON.stringify({schemaVersion:value.schemaVersion,maintenance:{active:value.maintenance?.active,operationId:value.maintenance?.operationId,expiresAt:value.maintenance?.expiresAt},idle:value.idle}));
} catch { console.error('Maintenance readiness unavailable.');process.exitCode=1; }
`;
async function queryIdle(root) {
  return JSON.parse(await command('docker', compose(root, ['exec', '-T', 'server', 'node', '--input-type=module', '-e', IDLE_PROGRAM]), 15_000));
}

export async function verifiedAutomaticBackups(directory) {
  const verified = [], rejected = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!AUTO_NAME.test(entry.name)) continue; // Manual backups and arbitrary directories are never eligible for deletion.
    const path = join(directory, entry.name);
    try {
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new OperationsError('非普通目录。');
      await privateDirectory(path);
      const names = (await readdir(path)).sort();
      if (names.join(',') !== 'manifest.json,snapshot.tar.gz.age') throw new OperationsError('目录内容不完整或含有额外文件。');
      await ordinaryFile(join(path, 'manifest.json'), 64 * 1024);
      const manifest = validateManifest(JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8')));
      if (!Number.isFinite(Date.parse(manifest.createdAt))) throw new OperationsError('备份时间无效。');
      const archive = join(path, 'snapshot.tar.gz.age'), archiveStat = await ordinaryFile(archive);
      if (archiveStat.size !== manifest.archiveBytes || await digest(archive) !== manifest.sha256) throw new OperationsError('密文摘要不一致。');
      verified.push({ name: entry.name, path, manifest });
    } catch { rejected.push(entry.name); }
  }
  verified.sort((a, b) => Date.parse(b.manifest.createdAt) - Date.parse(a.manifest.createdAt) || b.name.localeCompare(a.name));
  return { verified, rejected };
}
export async function retainAutomaticBackups(directory, newestPath, retention = 7) {
  if (retention !== 7) throw new OperationsError('自动保留策略需要7份成功副本。');
  const result = await verifiedAutomaticBackups(directory);
  // Only after this run's success is independently verified can historical files be removed.
  if (!result.verified.some(item => item.path === newestPath)) throw new OperationsError('本次备份未通过完整性验证，未清理旧副本。');
  const protectedPaths = new Set([newestPath, ...result.verified.filter(item => item.path !== newestPath).slice(0, retention - 1).map(item => item.path)]);
  let removed = 0;
  for (const item of result.verified) {
    if (protectedPaths.has(item.path)) continue;
    // No recursive deletion: only the two verified ordinary files and the now-empty controlled directory.
    await ordinaryFile(join(item.path, 'manifest.json'), 64 * 1024);
    await ordinaryFile(join(item.path, 'snapshot.tar.gz.age'));
    await unlink(join(item.path, 'snapshot.tar.gz.age'));
    await unlink(join(item.path, 'manifest.json'));
    await rmdir(item.path); removed++;
  }
  return { retainedCount: result.verified.length - removed, rejectedCount: result.rejected.length };
}

export function healthSummary(report) {
  const raw = report.checks ?? [];
  const byName = name => raw.find(check => check.name === name);
  const checks = [];
  const basic = (name, rows, failedCode) => checks.push({ name, ok: rows.every(row => row?.ok === true),
    severity: rows.every(row => row?.ok === true) ? 'ok' : 'critical', code: rows.every(row => row?.ok === true) ? 'healthy' : failedCode });
  basic('disk', [byName('disk')], 'low_space');
  basic('services', ['runner', 'server', 'proxy'].map(byName), 'unavailable');
  basic('api', [byName('address'), byName('https-api')], 'unavailable');
  const certificate = byName('certificate')?.detail;
  const validCertificate = certificate && Number.isFinite(Date.parse(certificate.expiresAt)) && Number.isFinite(certificate.remainingHours);
  const hours = validCertificate ? certificate.remainingHours : null;
  const severity = hours === null || hours < 24 ? 'critical' : hours < 48 ? 'warning' : 'ok';
  checks.push({ name: 'tls', ok: severity === 'ok', severity, code: hours === null ? 'unavailable' : hours <= 0 ? 'expired' : hours < 48 ? 'expiring' : 'healthy' });
  return { schemaVersion: 1, checkedAt: report.checkedAt, ok: checks.every(check => check.ok), checks,
    ...(validCertificate ? { certificate: { expiresAt: certificate.expiresAt, remainingHours: hours } } : {}) };
}
export async function runHealth(config, dependencies = {}) {
  return exclusive(config.stateDirectory, '.health-lock', async () => {
    let report;
    try { report = healthSummary(await (dependencies.health ?? checkHealth)(config.root)); }
    catch { report = healthSummary({ checkedAt: stamp(Date.now()), checks: [] }); }
    await atomicJson(config.stateDirectory, 'health.json', report);
    return { ok: report.ok, checkedAt: report.checkedAt };
  });
}
export async function runBackup(config, dependencies = {}) {
  const now = dependencies.now ?? Date.now, idle = dependencies.idle ?? queryIdle;
  const backup = dependencies.backup ?? backupDeployment, retention = dependencies.retention ?? retainAutomaticBackups;
  const root = config.root, directory = config.stateDirectory;
  return exclusive(directory, '.backup-lock', async () => {
    const previous = await state(directory, 'backup.json');
    if (!backupDue(previous?.lastSuccessAt, now(), config.hourUtc, config.minuteUtc)) return { ok: true, status: 'not-due' };
    const operationId = randomUUID(), startedAt = stamp(now()), output = join(config.backupDirectory, 'auto-v1-' + startedAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z') + '-' + operationId);
    const base = { schemaVersion: 1, lastAttemptAt: startedAt, lastSuccessAt: previous?.lastSuccessAt ?? null,
      ...(previous?.archive ? { archive: previous.archive } : {}), ...(Number.isSafeInteger(previous?.retainedCount) ? { retainedCount: previous.retainedCount } : {}) };
    let renewalError = false, leaseTimer, stopped = false, cleared = false, gateChain = Promise.resolve();
    const renew = () => {
      gateChain = gateChain.then(() => atomicJson(directory, 'maintenance.json', { schemaVersion: 1, reason: 'backup', operationId, startedAt, expiresAt: stamp(now() + GATE_MS) }));
      return gateChain;
    };
    const clear = async () => {
      if (cleared) return;
      clearInterval(leaseTimer); await gateChain.catch(() => {});
      const current = await state(directory, 'maintenance.json');
      if (current?.operationId === operationId) await unlink(join(directory, 'maintenance.json'));
      cleared = true;
    };
    const ensureIdle = async () => {
      if (renewalError) throw new OperationsError('维护状态更新失败。');
      await renew();
      if (!maintenanceIdle(await idle(root), operationId, now())) throw new DeferredBackup();
    };
    try {
      // Preserve an existing valid or invalid gate for manual investigation; never steal another operation.
      const oldGate = await state(directory, 'maintenance.json');
      if (oldGate) throw new OperationsError('维护标记已存在，需要检查前次运维。');
      await atomicJson(directory, 'backup.json', { ...base, status: 'running' });
      await ensureIdle();
      leaseTimer = setInterval(() => { renew().catch(() => { renewalError = true; }); }, 30_000);
      const result = await backup(root, output, config.recipient, {
        beforeStop: async () => { await ensureIdle(); stopped = true; },
        afterRestart: clear,
      });
      await clear();
      const manifest = { createdAt: result.createdAt, archiveBytes: result.archiveBytes, sha256: result.sha256 };
      const success = { ...base, status: 'ok', lastSuccessAt: stamp(now()), archive: manifest };
      // Success is durable before retention; a retention error must not hide a valid latest backup.
      await atomicJson(directory, 'backup.json', success);
      try {
        const retained = await retention(config.backupDirectory, output, 7);
        await atomicJson(directory, 'backup.json', { ...success, ...retained, ...(retained.rejectedCount ? { retentionWarning: true } : {}) });
      } catch {
        await atomicJson(directory, 'backup.json', { ...success, retentionWarning: true });
        return { ok: false, status: 'retention-failed' };
      }
      return { ok: true, status: 'ok' };
    } catch (error) {
      const deferred = error instanceof DeferredBackup && !stopped;
      await atomicJson(directory, 'backup.json', { ...base, status: deferred ? 'deferred' : 'failed',
        lastError: deferred ? '用户任务尚未结束，下一轮自动重试。' : '自动备份未完成，请检查运维日志及服务状态。' });
      return { ok: deferred, status: deferred ? 'deferred' : 'failed' };
    } finally { await clear(); }
  });
}
class DeferredBackup extends Error {}
async function main() {
  const { values } = parseArgs({ options: { config: { type: 'string' }, mode: { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help || !values.config || !['backup', 'health'].includes(values.mode)) {
    console.log('node deploy/scheduled-operations.mjs --config <root-owned-json> --mode backup|health');
    if (!values.help) process.exitCode = 1; return;
  }
  const config = await loadConfig(resolve(values.config));
  const result = await (values.mode === 'backup' ? runBackup : runHealth)(config);
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => {
  console.error('自动运维未完成；请检查受保护配置、独占锁和磁盘，未输出凭据或原始响应。'); process.exitCode = 1;
});
