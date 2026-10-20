import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod';
import type { PlanProfile } from './profile-store.js';
import { OPENAI_OIDC, PLAN_APP, PLAN_SCOPE, PLAN_SCOPES, PlanAuthError } from './types.js';

const tokenText = z.string().min(1).max(24_000).refine(value => !/[\r\n\0]/.test(value));
const Tokens = z.object({
  access_token: tokenText, refresh_token: tokenText.optional(), id_token: tokenText.optional(),
  token_type: z.string().refine(value => value.toLowerCase() === 'bearer'),
  expires_in: z.number().int().positive().max(31_536_000), scope: z.string().max(4096).optional(),
});
type TokenResponse = z.infer<typeof Tokens>;
export type IdentityExpectation = { clientId: string; nonce?: string; subject?: string; now: number };
export type IdentityVerifier = (idToken: string, expected: IdentityExpectation) => Promise<{ subject: string }>;
export type PlanOAuthDependencies = { fetch?: typeof fetch; verifyIdentity?: IdentityVerifier; now?: () => number; appName?: string };

/** Key resolver injection is for offline signature tests; production always uses the fixed JWKS. */
export function createIdentityVerifier(keys: JWTVerifyGetKey = createRemoteJWKSet(new URL(OPENAI_OIDC.jwks), {
  timeoutDuration: 10_000, cooldownDuration: 30_000, cacheMaxAge: 3_600_000,
})): IdentityVerifier {
  return async (token, expected) => {
    try {
      const { payload } = await jwtVerify(token, keys, {
        issuer: OPENAI_OIDC.issuer, audience: expected.clientId,
        algorithms: ['RS256', 'ES256'], requiredClaims: ['sub', 'exp', 'iat'], clockTolerance: 5,
        currentDate: new Date(expected.now),
      });
      if (!payload.sub || (expected.subject !== undefined && payload.sub !== expected.subject)
          || (expected.nonce !== undefined && payload.nonce !== expected.nonce)
          || typeof payload.iat !== 'number' || payload.iat > expected.now / 1000 + 5
          || (payload.azp !== undefined && payload.azp !== expected.clientId)
          || (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== expected.clientId)) {
        throw new Error('invalid identity');
      }
      return { subject: payload.sub };
    } catch { throw new PlanAuthError('invalid_response', 'ChatGPT 身份验证未通过，请重新授权。'); }
  };
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function requiredScopes(scopes: string[]): string[] {
  if (![PLAN_SCOPE, 'resource.invoke', 'offline_access'].every(scope => scopes.includes(scope))) {
    throw new PlanAuthError('sign_in_required', '本应用尚未获准使用 ChatGPT 套餐，请重新授权所需权限。');
  }
  return [...new Set(scopes)];
}
async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('empty response');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const item = await reader.read(); if (item.done) break;
      length += item.value.byteLength;
      if (length > 65_536) throw new Error('response too large');
      chunks.push(item.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** A single-use transaction remains memory-only, including its PKCE verifier. */
export class PlanSignInAttempt {
  readonly authorizationUrl: string;
  readonly expiresAt: number;
  private consumed = false;
  private readonly state = randomBytes(32).toString('base64url');
  private readonly nonce = randomBytes(32).toString('base64url');
  private readonly verifier = randomBytes(64).toString('base64url');
  constructor(
    private readonly oauth: PlanOAuth,
    readonly redirectUri: string,
    readonly hostId: string,
    readonly previous: PlanProfile | null,
    now: number,
  ) {
    const uri = new URL(redirectUri);
    if (uri.protocol !== 'http:' || uri.hostname !== '127.0.0.1' || !uri.port
        || uri.pathname !== '/auth/callback' || uri.search || uri.hash || uri.username || uri.password) {
      throw new PlanAuthError('invalid_response', '授权回调必须使用本机随机端口和固定回调路径。');
    }
    this.expiresAt = now + 600_000;
    const url = new URL(OPENAI_OIDC.authorize);
    url.search = new URLSearchParams({
      client_id: previous?.clientId ?? 'dynamic_agent_client',
      ...(!previous ? { agent_name_hint: oauth.appName } : {}),
      ext_agent_host_id: hostId, response_type: 'code', redirect_uri: redirectUri,
      scope: PLAN_SCOPES.join(' '), resource: OPENAI_OIDC.resource,
      state: this.state, nonce: this.nonce, code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(this.verifier).digest('base64url'),
    }).toString();
    // Omit optional identity hints so the administrator can safely display this URL.
    this.authorizationUrl = url.toString();
  }
  async complete(callbackUrl: string, signal?: AbortSignal): Promise<PlanProfile> {
    if (this.consumed) throw new PlanAuthError('invalid_response', '授权回调已使用，请重新开始登录。');
    this.consumed = true;
    let callback: URL;
    try { callback = new URL(callbackUrl); }
    catch { throw new PlanAuthError('invalid_response', '授权回调无效，请重新开始登录。'); }
    const target = new URL(this.redirectUri);
    if (this.oauth.now() >= this.expiresAt || callback.origin !== target.origin || callback.pathname !== target.pathname
        || callback.hash || callback.username || callback.password
        || ['state', 'code', 'client_id', 'error'].some(name => callback.searchParams.getAll(name).length > 1)
        || !safeEqual(callback.searchParams.get('state') ?? '', this.state)) {
      throw new PlanAuthError('invalid_response', '授权请求已过期或无法验证，请重新开始登录。');
    }
    if (callback.searchParams.has('error')) throw new PlanAuthError('sign_in_required', 'ChatGPT 授权未完成，未保存任何新凭据。');
    const clientId = callback.searchParams.get('client_id') ?? this.previous?.clientId;
    const code = callback.searchParams.get('code');
    if (!code || code.length > 8192 || !clientId || clientId === 'dynamic_agent_client' || clientId.length > 512
        || (this.previous && clientId !== this.previous.clientId)) {
      throw new PlanAuthError('invalid_response', '授权回调缺少有效注册信息，请重新开始登录。');
    }
    const tokens = await this.oauth.requestTokens({
      grant_type: 'authorization_code', client_id: clientId, code, code_verifier: this.verifier,
      redirect_uri: this.redirectUri, resource: OPENAI_OIDC.resource,
    }, signal);
    if (!tokens.id_token || !tokens.refresh_token || !tokens.scope) {
      throw new PlanAuthError('invalid_response', 'ChatGPT 未返回完整的套餐授权，请重新授权。');
    }
    const now = this.oauth.now();
    const identity = await this.oauth.verify(tokens.id_token, { clientId, nonce: this.nonce, subject: this.previous?.subject, now });
    signal?.throwIfAborted();
    return {
      version: 1, revision: randomUUID(), hostId: this.hostId, clientId, appName: this.previous?.appName ?? this.oauth.appName,
      issuer: OPENAI_OIDC.issuer, subject: identity.subject,
      idToken: tokens.id_token, accessToken: tokens.access_token, refreshToken: tokens.refresh_token,
      scopes: requiredScopes(tokens.scope.split(/\s+/).filter(Boolean)),
      expiresAt: now + tokens.expires_in * 1000, savedAt: now,
    };
  }
}

/** Fixed official endpoints only; this class never accepts a user-provided issuer/URL. */
export class PlanOAuth {
  private readonly transport: typeof fetch;
  readonly verify: IdentityVerifier;
  readonly now: () => number;
  readonly appName: string;
  constructor(dependencies: PlanOAuthDependencies = {}) {
    this.transport = dependencies.fetch ?? fetch;
    this.verify = dependencies.verifyIdentity ?? createIdentityVerifier();
    this.now = dependencies.now ?? Date.now;
    this.appName = dependencies.appName ?? PLAN_APP.name;
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(this.appName)) throw new PlanAuthError('invalid_response', '本应用注册名称配置无效。');
  }
  begin(redirectUri: string, hostId: string, previous: PlanProfile | null): PlanSignInAttempt {
    return new PlanSignInAttempt(this, redirectUri, hostId, previous, this.now());
  }
  async requestTokens(body: Record<string, string>, signal?: AbortSignal): Promise<TokenResponse> {
    try {
      signal?.throwIfAborted();
      const response = await this.transport(OPENAI_OIDC.token, {
        method: 'POST', redirect: 'error', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body), signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new PlanAuthError(response.status >= 500 || [408, 429].includes(response.status) ? 'network' : 'sign_in_required',
          response.status >= 500 || [408, 429].includes(response.status) ? 'ChatGPT 授权服务暂时不可用，请稍后重试。' : 'ChatGPT 授权已失效或未获许可，请重新登录本应用。');
      }
      const parsed = Tokens.safeParse(await boundedJson(response));
      if (!parsed.success) throw new PlanAuthError('invalid_response', 'ChatGPT 授权响应格式不兼容，未更新凭据。');
      return parsed.data;
    } catch (error) {
      if (signal?.aborted) throw new PlanAuthError('cancelled', 'ChatGPT 授权操作已取消。');
      if (error instanceof PlanAuthError) throw error;
      throw new PlanAuthError('network', '无法完成 ChatGPT 授权请求，请检查网络后重试。');
    }
  }
  async refresh(previous: PlanProfile, signal?: AbortSignal): Promise<PlanProfile> {
    const tokens = await this.requestTokens({
      grant_type: 'refresh_token', client_id: previous.clientId,
      refresh_token: previous.refreshToken, resource: OPENAI_OIDC.resource,
    }, signal);
    const now = this.now();
    if (tokens.id_token) await this.verify(tokens.id_token, { clientId: previous.clientId, subject: previous.subject, now });
    // Standard OAuth may omit an unchanged refresh token or granted scope.
    // Once a response arrives, persist its rotation even if the task was cancelled.
    return { ...previous, revision: randomUUID(), savedAt: now, expiresAt: now + tokens.expires_in * 1000,
      accessToken: tokens.access_token, refreshToken: tokens.refresh_token ?? previous.refreshToken,
      idToken: tokens.id_token ?? previous.idToken,
      scopes: requiredScopes(tokens.scope === undefined ? previous.scopes : tokens.scope.split(/\s+/).filter(Boolean)),
    };
  }
}
