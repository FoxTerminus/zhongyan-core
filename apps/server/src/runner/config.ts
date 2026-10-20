import { isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import { DEFAULT_RUNNER_OUTPUT_BYTES, DEFAULT_RUNNER_TURN_MS } from '../runtime/remote-protocol.js';

const Environment = z.object({
  RUNNER_HOST: z.string().min(1).default('127.0.0.1'),
  RUNNER_PORT: z.coerce.number().int().min(1).max(65535).default(8788),
  AGENT_RUNNER_AUTH_TOKEN: z.string().min(32).max(8192).regex(/^\S+$/),
  AGENT_CHATGPT_PROFILE_DIR: z.string().min(1),
  AGENT_RUNNER_WORKSPACE: z.string().min(1),
  AGENT_CODEX_COMMAND: z.string().min(1).default('codex'),
  AGENT_CODEX_MODEL: z.preprocess(value => value === '' ? undefined : value, z.string().min(1).optional()),
  AGENT_APP_TITLE: z.string().min(1).max(100).default('Personal Agent'),
  AGENT_RUNNER_TURN_TIMEOUT_MS: z.coerce.number().int().min(1000).max(3_600_000).default(DEFAULT_RUNNER_TURN_MS),
  AGENT_RUNNER_MAX_OUTPUT_BYTES: z.coerce.number().int().min(65_536).max(16_777_216).default(DEFAULT_RUNNER_OUTPUT_BYTES),
});
function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`));
}
export function loadRunnerConfig(env: NodeJS.ProcessEnv = process.env) {
  const result = Environment.safeParse(env);
  if (!result.success) throw new Error('私有执行器配置不完整或无效。');
  const c = result.data;
  const profileDir = resolve(c.AGENT_CHATGPT_PROFILE_DIR);
  const workspace = resolve(c.AGENT_RUNNER_WORKSPACE);
  if (contains(profileDir, workspace) || contains(workspace, profileDir)) throw new Error('执行器授权目录和工作目录必须分离。');
  // The runner must not inherit the public API/device credential.
  if (env.AGENT_AUTH_TOKEN) throw new Error('执行器不得加载设备访问密钥。');
  return {
    host: c.RUNNER_HOST, port: c.RUNNER_PORT, token: c.AGENT_RUNNER_AUTH_TOKEN,
    profileDir, workspace, command: c.AGENT_CODEX_COMMAND, model: c.AGENT_CODEX_MODEL,
    appTitle: c.AGENT_APP_TITLE, turnTimeoutMs: c.AGENT_RUNNER_TURN_TIMEOUT_MS,
    maxOutputBytes: c.AGENT_RUNNER_MAX_OUTPUT_BYTES,
  };
}
export type RunnerConfig = ReturnType<typeof loadRunnerConfig>;
