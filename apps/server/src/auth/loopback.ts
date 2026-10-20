import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FilePlanProfileStore } from './profile-store.js';
import { PlanOAuth, type PlanSignInAttempt } from './oauth.js';
import { PlanAuthError } from './types.js';

type LoginStore = Pick<FilePlanProfileStore, 'hostId' | 'withLock' | 'read' | 'write'>;
/** Administrator-only local helper, deliberately not mounted in the public API. */
export async function authorizePlanProfile(store: LoginStore, options: {
  onReady(authorizationUrl: string): void;
  signal?: AbortSignal;
}, oauth = new PlanOAuth()): Promise<void> {
  const hostId = await store.hostId();
  await store.withLock(async () => {
    const previous = await store.read();
    options.signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      let attempt: PlanSignInAttempt | null = null;
      let settled = false;
      let inFlight: Promise<void> | null = null;
      let expectedHost = '';
      const controller = new AbortController();
      const respond = (response: ServerResponse, status: number, text: string) => {
        response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store',
          'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'" });
        response.end(text);
      };
      const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
        if (request.method !== 'GET' || request.headers.host !== expectedHost || !request.url
            || request.url.length > 16_384 || !request.url.startsWith('/auth/callback?')) {
          respond(response, 404, 'Not found.'); return;
        }
        if (!attempt || inFlight || settled) { respond(response, 409, 'This sign-in attempt has already been handled.'); return; }
        inFlight = (async () => {
          try {
            const profile = await attempt!.complete(`http://${expectedHost}${request.url}`, controller.signal);
            controller.signal.throwIfAborted();
            await store.write(profile);
            respond(response, 200, 'ChatGPT authorization saved for this application. You may close this window.');
          } catch (error) {
            respond(response, 400, 'Sign-in could not be completed. Return to the administrator terminal.');
            throw error instanceof PlanAuthError ? error : new PlanAuthError('storage', '未能安全保存本应用授权，请检查权限后重新登录。');
          }
        })();
        void inFlight.then(() => finish(), error => finish(error));
      });
      server.headersTimeout = 5_000; server.requestTimeout = 10_000; server.timeout = 10_000;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (error) controller.abort();
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        server.close();
        if (error) server.closeAllConnections();
        // Keep the profile lock until any started exchange/write has settled.
        // A cancellation must not let a second process race an in-flight commit.
        const complete = () => { if (error) reject(error); else resolve(); };
        if (inFlight) void inFlight.then(complete, complete); else complete();
      };
      const onAbort = () => finish(new PlanAuthError('cancelled', 'ChatGPT 登录已取消。'));
      const timer = setTimeout(() => finish(new PlanAuthError('sign_in_required', '登录已超时，请重新开始授权。')), 600_000);
      options.signal?.addEventListener('abort', onAbort, { once: true });
      server.once('error', () => finish(new PlanAuthError('network', '无法启动本机登录回调，请检查端口或系统权限。')));
      server.listen(0, '127.0.0.1', () => {
        try {
          if (options.signal?.aborted) { onAbort(); return; }
          const address = server.address() as AddressInfo;
          expectedHost = `127.0.0.1:${address.port}`;
          attempt = oauth.begin(`http://${expectedHost}/auth/callback`, hostId, previous);
          options.onReady(attempt.authorizationUrl);
        } catch { finish(new PlanAuthError('network', '无法准备本应用登录，请检查配置。')); }
      });
    });
  });
}
