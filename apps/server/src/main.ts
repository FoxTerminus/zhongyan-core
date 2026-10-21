import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { KnowledgeStore } from './knowledge.js';
import { NotificationStore } from './notifications.js';
import { CodexRuntime } from './runtime/codex.js';
import { DisabledRuntime } from './runtime/unavailable.js';
import { RemoteRuntime } from './runtime/remote.js';
import { FilePlanProfileStore } from './auth/profile-store.js';
import { StoredPlanCredentialProvider } from './auth/provider.js';
import { createKnowledgeToolRegistry } from './tools/knowledge.js';

const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true });
const runtimeDir = join(config.dataDir, 'workspace');
mkdirSync(runtimeDir, { recursive: true });
const knowledge = new KnowledgeStore(join(config.dataDir, 'knowledge.sqlite'));
const notifications = new NotificationStore(join(config.dataDir, 'notifications.sqlite'));
const runtime = config.runtime === 'remote'
  ? new RemoteRuntime({ url: config.runnerUrl!, token: config.runnerToken!,
    turnTimeoutMs: config.runnerTurnTimeoutMs, maxOutputBytes: config.runnerMaxOutputBytes })
  : config.runtime === 'codex'
  ? new CodexRuntime({ command: config.command, cwd: runtimeDir, model: config.model,
    knowledgeTools: config.knowledgeTools, appTitle: config.appTitle,
    planCredentials: config.authMode === 'chatgpt-plan'
      ? new StoredPlanCredentialProvider(new FilePlanProfileStore(config.planProfileDir)) : undefined,
    toolRegistry: config.knowledgeTools === 'experimental' ? createKnowledgeToolRegistry(knowledge) : undefined,
  })
  : new DisabledRuntime();
const app = createApp({ store: new Store(join(config.dataDir, 'agent.sqlite')), runtime,
  knowledge,
  notifications,
  operationsDir: config.operationsDir,
  authToken: config.authToken, allowedOrigins: config.allowedOrigins });
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  if (closing) return;
  closing = true;
  void app.close().then(() => { process.exitCode = 0; }).catch(() => { process.exitCode = 1; });
});
try {
  await app.listen({ host: config.host, port: config.port });
  console.log(`Personal Agent listening on ${config.host}:${config.port}; runtime=${config.runtime}`);
} catch {
  console.error('服务启动失败，请检查端口、数据目录和配置。');
  await app.close();
  process.exitCode = 1;
}
