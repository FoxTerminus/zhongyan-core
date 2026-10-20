import type { FilePlanProfileStore, PlanProfile } from './profile-store.js';
import { PlanOAuth } from './oauth.js';
import { OPENAI_OIDC, PLAN_SCOPE, PlanAuthError, type PlanCredentialLease, type PlanCredentialProvider, type PlanCredentialStatus } from './types.js';

type ProfileStore = Pick<FilePlanProfileStore, 'read' | 'withLock' | 'write' | 'prepareRuntimeHome'>;
/** One selected registration per profile directory. Changing accounts needs a separate directory. */
export class StoredPlanCredentialProvider implements PlanCredentialProvider {
  constructor(private readonly store: ProfileStore, private readonly oauth = new PlanOAuth(), private readonly now = Date.now) {}
  private valid(profile: PlanProfile | null): profile is PlanProfile {
    return Boolean(profile && profile.issuer === OPENAI_OIDC.issuer && profile.clientId !== 'dynamic_agent_client'
      && profile.scopes.includes(PLAN_SCOPE) && profile.scopes.includes('resource.invoke'));
  }
  async inspect(): Promise<PlanCredentialStatus> {
    try {
      const profile = await this.store.read();
      if (!this.valid(profile)) return { authenticated: false, expiresAt: null, message: '本应用尚未独立登录 ChatGPT，请由管理员完成官方授权。' };
      return { authenticated: true, expiresAt: profile.expiresAt,
        message: profile.expiresAt <= this.now() + 60_000
          ? '已保存本应用的独立授权；下次任务需要续期，状态检查不会刷新令牌。'
          : '已保存本应用的独立授权；实际模型权限尚待运行验证。' };
    } catch { throw new PlanAuthError('storage', '无法安全读取本应用授权目录，请检查权限。'); }
  }
  async acquire(allowRefresh: boolean, signal?: AbortSignal): Promise<PlanCredentialLease> {
    signal?.throwIfAborted();
    const read = async (): Promise<PlanProfile> => {
      const profile = await this.store.read();
      if (!this.valid(profile)) throw new PlanAuthError('sign_in_required', '请先完成本应用的独立 ChatGPT 登录。');
      return profile;
    };
    try {
      let profile = await read();
      if (profile.expiresAt <= this.now() + 60_000) {
        if (!allowRefresh) throw new PlanAuthError('sign_in_required', '已保存的授权需要续期；状态检查不会触发续期。');
        profile = await this.store.withLock(async () => {
          const latest = await read(); // Another process may have refreshed while we waited.
          if (latest.expiresAt > this.now() + 60_000) return latest;
          signal?.throwIfAborted();
          // Once sent, a rotating refresh must finish under its own bounded
          // timeout: cancelling the task must not discard a replacement token.
          const replacement = await this.oauth.refresh(latest);
          await this.store.write(replacement); // Rotating refresh token and access token commit together.
          return replacement;
        });
      }
      signal?.throwIfAborted();
      return { accessToken: profile.accessToken, revision: profile.revision, expiresAt: profile.expiresAt,
        codexHome: await this.store.prepareRuntimeHome(), appName: profile.appName };
    } catch (error) {
      if (signal?.aborted) throw new PlanAuthError('cancelled', '授权准备已取消。');
      if (error instanceof PlanAuthError) throw error;
      throw new PlanAuthError('storage', '无法安全更新本应用授权，请检查目录权限或是否有其他登录进程。');
    }
  }
}
