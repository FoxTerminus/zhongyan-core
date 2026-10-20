import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { loadRunnerConfig } from './config.js';
import { ManagedPlanRuntime } from './runtime.js';
import { createRunnerServer } from './server.js';

const config = loadRunnerConfig();
if (process.platform !== 'linux') throw new Error('私有执行器入口仅支持 Linux 容器。');
mkdirSync(config.workspace, { recursive: true, mode: 0o700 });
if (!lstatSync(config.workspace).isDirectory() || lstatSync(config.workspace).isSymbolicLink()
  || realpathSync(config.workspace) !== config.workspace) throw new Error('执行器工作目录必须是独立的真实目录。');
const runner = createRunnerServer({
  token: config.token, turnTimeoutMs: config.turnTimeoutMs, maxOutputBytes: config.maxOutputBytes,
  createRuntime: () => new ManagedPlanRuntime(config),
});
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  if (closing) return;
  closing = true;
  void runner.close().then(() => { process.exitCode = 0; }).catch(() => { process.exitCode = 1; });
});
runner.server.on('error', () => {
  console.error('私有执行器启动或连接失败，请检查端口和配置。');
  void runner.close().finally(() => { process.exitCode = 1; });
});
runner.server.listen(config.port, config.host, () => {
  console.log(`Private runner listening on ${config.host}:${config.port}; tools=disabled`);
});
