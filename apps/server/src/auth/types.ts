/** Stable app identity: registration and app-server attribution must agree. */
export const PLAN_APP = Object.freeze({ name: 'personal_agent', title: 'Personal Agent', version: '0.1.0' });
export const OPENAI_OIDC = Object.freeze({
  issuer: 'https://auth.openai.com',
  discovery: 'https://auth.openai.com/.well-known/openid-configuration',
  authorize: 'https://auth.openai.com/api/accounts/authorize',
  token: 'https://auth.openai.com/api/accounts/oauth/token',
  jwks: 'https://auth.openai.com/.well-known/jwks.json',
  resource: 'https://api.openai.com/v1',
});
export const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
export const PLAN_SCOPES = ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', PLAN_SCOPE];
export class PlanAuthError extends Error {
  constructor(public readonly code: 'sign_in_required' | 'invalid_response' | 'network' | 'cancelled' | 'storage' | 'busy', message: string) {
    super(message); this.name = 'PlanAuthError';
  }
}
/** Deliberately excludes identity and credentials from user-visible status. */
export type PlanCredentialStatus = { authenticated: boolean; expiresAt: number | null; message: string };
/** Internal only. Never serialize this value into API responses, events or logs. */
export type PlanCredentialLease = { accessToken: string; revision: string; expiresAt: number; codexHome: string; appName: string };
export interface PlanCredentialProvider {
  /** Read-only; must not refresh, initiate OAuth, launch a model or read desktop auth. */
  inspect(): Promise<PlanCredentialStatus>;
  /** allowRefresh is reserved for an explicit user task, never a status poll. */
  acquire(allowRefresh: boolean, signal?: AbortSignal): Promise<PlanCredentialLease>;
}
