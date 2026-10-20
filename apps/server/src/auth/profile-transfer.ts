import { randomUUID } from 'node:crypto';
import { parsePlanProfile, type FilePlanProfileStore } from './profile-store.js';
import { PLAN_SCOPE, PlanAuthError } from './types.js';

type TargetStore = Pick<FilePlanProfileStore, 'withLock' | 'hostId' | 'read' | 'write'>;

/** Import a specifically transferred app registration; preserve the VM's host ID. */
export async function importPlanProfile(value: unknown, target: TargetStore, expectedAppName: string): Promise<void> {
  const profile = parsePlanProfile(value);
  if (profile.appName !== expectedAppName || !profile.scopes.includes(PLAN_SCOPE)
      || !profile.scopes.includes('resource.invoke')) {
    throw new PlanAuthError('invalid_response', '迁移配置不属于此应用，或未授予 ChatGPT 套餐使用权限。');
  }
  await target.withLock(async () => {
    if (await target.read()) throw new PlanAuthError('storage', '目标已经有授权记录；请使用现有授权或在独立目录重新授权，未覆盖。');
    const hostId = await target.hostId();
    if (hostId === profile.hostId) {
      throw new PlanAuthError('storage', '目标主机身份与来源相同；迁移时不能复制来源主机的 host.json。');
    }
    // A transfer is not token refresh. The VM owns subsequent refreshes.
    await target.write({ ...profile, hostId, revision: randomUUID(), savedAt: Date.now() });
  });
}

export async function readTransferredProfile(input: AsyncIterable<Buffer | string>): Promise<unknown> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of input) {
    const data = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    bytes += data.length;
    if (bytes > 64 * 1024) throw new PlanAuthError('invalid_response', '迁移配置超过大小限制。');
    chunks.push(data);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new PlanAuthError('invalid_response', '迁移配置格式无效。'); }
}
