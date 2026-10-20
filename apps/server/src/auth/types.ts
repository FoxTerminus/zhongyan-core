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
/**
 * This application uses the UUIDv4 URI alternative supported by SIWC.
 * Bare UUIDs are accepted only by the version-1 storage migration, never by OAuth.
 * Other supported SIWC identifier families require an explicit future schema change.
 */
export function isPlanHostId(value: unknown): value is string {
  return typeof value === 'string' && value.length === 45
    && /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    && value.startsWith('urn:uuid:');
}

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
