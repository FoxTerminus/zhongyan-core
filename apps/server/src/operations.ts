import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { OperationsStatus } from '@personal-agent/contracts';
import { DomainError } from './errors.js';

const Timestamp = z.string().datetime();
const CheckName = z.enum(['api', 'tls', 'services', 'disk']);
const CheckCode = z.enum(['healthy', 'unavailable', 'expiring', 'expired', 'low_space', 'failed', 'unknown']);
const MaintenanceFile = z.object({
  schemaVersion: z.literal(1), reason: z.literal('backup'), operationId: z.string().uuid(),
  startedAt: Timestamp, expiresAt: Timestamp,
});
const HealthFile = z.object({
  schemaVersion: z.literal(1), checkedAt: Timestamp, ok: z.boolean(),
  checks: z.array(z.object({ name: CheckName, ok: z.boolean(), severity: z.enum(['ok', 'warning', 'critical']), code: CheckCode.optional() })).length(4)
    .refine(checks => new Set(checks.map(c => c.name)).size === 4),
  certificate: z.object({ expiresAt: Timestamp, remainingHours: z.number().finite() }).optional(),
});
const BackupFile = z.object({
  schemaVersion: z.literal(1), lastAttemptAt: Timestamp, lastSuccessAt: Timestamp.nullable(),
  status: z.enum(['running', 'ok', 'deferred', 'failed']),
  archive: z.object({ createdAt: Timestamp, archiveBytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).optional(),
  retainedCount: z.number().int().nonnegative().optional(),
  retentionWarning: z.boolean().optional(),
  rejectedCount: z.number().int().nonnegative().optional(),
});
type FileResult = { state: 'value'; value: unknown } | { state: 'missing' | 'invalid' | 'unconfigured' };
const MAX_REPORT_BYTES = 64 * 1024;
const CLOCK_SKEW_MS = 60_000;
export const HEALTH_STALE_MS = 20 * 60_000;
export const BACKUP_STALE_MS = 36 * 60 * 60_000;
const checkMessages: Record<z.infer<typeof CheckName>, string> = {
  api: '云端接口', tls: 'HTTPS 证书', services: '服务进程', disk: '服务器磁盘',
};
const checkExplanations: Record<z.infer<typeof CheckCode>, string> = {
  healthy: '正常', unavailable: '无法访问', expiring: '即将过期，请检查自动续期', expired: '已过期',
  low_space: '空间不足', failed: '检查失败', unknown: '尚未确认',
};

/** The host atomically publishes a small, read-only directory mounted by deployment.
 * No URL or request body can select a filename. Never expose raw filesystem errors,
 * report detail, backup location, command output or model credentials to clients.
 */
export class OperationsReader {
  constructor(private directory?: string, private clock: () => number = Date.now) {}

  private read(name: 'maintenance.json' | 'health.json' | 'backup.json'): FileResult {
    if (!this.directory) return { state: 'unconfigured' };
    let descriptor: number | undefined;
    try {
      const root = lstatSync(this.directory);
      if (!root.isDirectory() || root.isSymbolicLink()) return { state: 'invalid' };
      const path = join(this.directory, name);
      let before;
      try { before = lstatSync(path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing' };
        throw error;
      }
      if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_REPORT_BYTES) return { state: 'invalid' };
      descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = fstatSync(descriptor);
      if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev || opened.size > MAX_REPORT_BYTES) return { state: 'invalid' };
      const buffer = Buffer.alloc(MAX_REPORT_BYTES + 1);
      const length = readSync(descriptor, buffer, 0, buffer.length, 0);
      if (length > MAX_REPORT_BYTES) return { state: 'invalid' };
      return { state: 'value', value: JSON.parse(buffer.subarray(0, length).toString('utf8')) };
    } catch { return { state: 'invalid' }; }
    finally { if (descriptor !== undefined) closeSync(descriptor); }
  }

  maintenance(now = this.clock()): OperationsStatus['maintenance'] {
    const file = this.read('maintenance.json');
    if (file.state === 'missing' || file.state === 'unconfigured') {
      return { active: false, state: 'inactive', message: '当前没有备份维护。' };
    }
    const parsed = file.state === 'value' ? MaintenanceFile.safeParse(file.value) : undefined;
    if (!parsed?.success) return { active: true, state: 'invalid', message: '维护状态异常，暂时不能发送新消息，请检查云端维护服务。' };
    const gate = parsed.data;
    const started = Date.parse(gate.startedAt), expires = Date.parse(gate.expiresAt);
    if (started > now + CLOCK_SKEW_MS || expires <= started || expires > now + 60 * 60_000) {
      return { active: true, state: 'invalid', message: '维护状态异常，暂时不能发送新消息，请检查云端维护服务。' };
    }
    // A crashed scheduler cannot leave a valid lease blocking messages forever.
    if (expires <= now) return { active: false, state: 'expired', operationId: gate.operationId, expiresAt: gate.expiresAt, message: '上次维护未正常结束，维护限制已自动解除。' };
    return { active: true, state: 'active', operationId: gate.operationId, expiresAt: gate.expiresAt, message: '正在准备云端备份，暂时不能发送新消息；现有任务仍可查看和取消。' };
  }

  /** Must remain synchronous with the following enqueue/retry. A loopback idle
   * request cannot observe an empty queue between this check and the mutation. */
  assertAcceptingTasks() {
    const gate = this.maintenance();
    if (gate.active) throw new DomainError('maintenance', gate.message, 503);
  }

  snapshot(idle: OperationsStatus['idle']): OperationsStatus {
    const now = this.clock();
    return { schemaVersion: 1, configured: Boolean(this.directory), checkedAt: new Date(now).toISOString(), maintenance: this.maintenance(now), idle,
      health: this.health(now), backup: this.backup(now) };
  }

  private health(now: number): OperationsStatus['health'] {
    const file = this.read('health.json');
    const empty = { checkedAt: null, checks: [] };
    if (file.state !== 'value') return { ...empty, state: file.state === 'invalid' ? 'error' : 'unknown', code: file.state,
      message: file.state === 'invalid' ? '无法读取有效的云端巡检记录，请检查巡检服务。' : file.state === 'unconfigured' ? '云端巡检尚未启用。' : '尚未收到首次云端巡检结果。' };
    const parsed = HealthFile.safeParse(file.value);
    if (!parsed.success || Date.parse(parsed.data.checkedAt) > now + CLOCK_SKEW_MS) {
      return { ...empty, state: 'error', code: 'invalid', message: '云端巡检记录格式或时间异常，请检查巡检服务。' };
    }
    const report = parsed.data;
    const checks: OperationsStatus['health']['checks'] = report.checks.map(check => {
      const code = check.code ?? (check.ok ? 'healthy' : 'failed');
      const state = check.severity === 'critical' ? 'error' : check.severity === 'warning' ? 'warning' : !check.ok ? 'error' : 'ok';
      return { name: check.name, state, code, message: `${checkMessages[check.name]}：${checkExplanations[code]}。` };
    });
    // Recompute remaining time; never present an old positive TTL as current.
    const certificate = report.certificate ? { expiresAt: report.certificate.expiresAt, remainingHours: (Date.parse(report.certificate.expiresAt) - now) / 3_600_000 } : undefined;
    if (certificate && certificate.remainingHours <= 0) {
      const tls = checks.find(check => check.name === 'tls')!;
      Object.assign(tls, { state: 'error', code: 'expired', message: 'HTTPS 证书：已过期。' });
    }
    const details = { checkedAt: report.checkedAt, checks, ...(certificate ? { certificate } : {}) };
    if (now - Date.parse(report.checkedAt) > HEALTH_STALE_MS) {
      return { ...details, state: 'warning', code: 'stale', message: '云端巡检结果已超过 20 分钟未更新，不能确认当前状态。' };
    }
    if (checks.some(c => c.state === 'error')) return { ...details, state: 'error', code: 'failed', message: '云端巡检发现异常，请查看下方检查结果。' };
    if (checks.some(c => c.state === 'warning')) return { ...details, state: 'warning', code: 'warning', message: '云端巡检发现需要处理的提醒。' };
    if (!report.ok) return { ...details, state: 'error', code: 'failed', message: '云端巡检状态不一致，请检查巡检服务。' };
    return { ...details, state: 'ok', code: 'healthy', message: '最近一次云端巡检正常。' };
  }

  private backup(now: number): OperationsStatus['backup'] {
    const file = this.read('backup.json');
    const empty = { lastAttemptAt: null, lastSuccessAt: null };
    if (file.state !== 'value') return { ...empty, state: file.state === 'invalid' ? 'error' : 'unknown', code: file.state,
      message: file.state === 'invalid' ? '无法读取有效的备份记录，请检查备份服务。' : file.state === 'unconfigured' ? '自动备份尚未启用。' : '尚无自动备份记录。' };
    const parsed = BackupFile.safeParse(file.value);
    if (!parsed.success || Date.parse(parsed.data.lastAttemptAt) > now + CLOCK_SKEW_MS ||
      (parsed.data.lastSuccessAt !== null && Date.parse(parsed.data.lastSuccessAt) > now + CLOCK_SKEW_MS) ||
      (parsed.data.archive && Date.parse(parsed.data.archive.createdAt) > now + CLOCK_SKEW_MS) ||
      (parsed.data.status === 'ok' && parsed.data.lastSuccessAt === null)) {
      return { ...empty, state: 'error', code: 'invalid', message: '备份记录格式或时间异常，请检查备份服务。' };
    }
    const report = parsed.data;
    const details = { lastAttemptAt: report.lastAttemptAt, lastSuccessAt: report.lastSuccessAt,
      ...(report.archive ? { archive: { createdAt: report.archive.createdAt, archiveBytes: report.archive.archiveBytes } } : {}),
      ...(report.retainedCount === undefined ? {} : { retainedCount: report.retainedCount }) };
    if (report.status === 'failed') return { ...details, state: 'error', code: 'failed', message: '最近一次自动备份失败，请检查备份服务；已有成功备份保留。' };
    if (report.status === 'running') {
      if (now - Date.parse(report.lastAttemptAt) > 2 * 60 * 60_000) return { ...details, state: 'error', code: 'stalled', message: '备份超过两小时未完成，请检查备份服务。' };
      return { ...details, state: 'unknown', code: 'running', message: '自动备份正在进行，完成前尚不能确认本次成功。' };
    }
    if (!report.lastSuccessAt) return { ...details, state: 'warning', code: report.status === 'deferred' ? 'deferred' : 'missing', message: report.status === 'deferred' ? '有任务正在运行，自动备份将稍后重试；尚无成功记录。' : '尚无成功的自动备份。' };
    if (now - Date.parse(report.lastSuccessAt) > BACKUP_STALE_MS) return { ...details, state: 'warning', code: 'stale', message: '已超过 36 小时没有成功备份，请检查备份服务。' };
    if (report.status === 'deferred') return { ...details, state: 'warning', code: 'deferred', message: '有任务正在运行，本次备份已推迟，已有备份保留。' };
    if (report.retentionWarning || (report.rejectedCount ?? 0) > 0) return { ...details, state: 'warning', code: 'retention_warning', message: '本次备份已完成，但历史备份清理需要检查。' };
    return { ...details, state: 'ok', code: 'healthy', message: '最近一次自动加密备份成功。' };
  }
}
