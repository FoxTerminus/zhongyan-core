import { resolve } from 'node:path';
import { z } from 'zod';
import { normalizeRunnerUrl } from './runtime/remote.js';
import { DEFAULT_RUNNER_OUTPUT_BYTES, DEFAULT_RUNNER_TURN_MS } from './runtime/remote-protocol.js';
const Environment = z.object({
  SERVER_HOST: z.string().default('127.0.0.1'),
  SERVER_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  AGENT_AUTH_TOKEN: z.string().min(32),
  AGENT_DATA_DIR: z.string().default('.data'),
  AGENT_RUNTIME: z.enum(['disabled', 'codex', 'remote']).default('disabled'),
  AGENT_RUNNER_URL: z.string().optional(),
  AGENT_RUNNER_AUTH_TOKEN: z.string().min(32).max(8192).regex(/^\S+$/).optional(),
  AGENT_RUNNER_TURN_TIMEOUT_MS: z.coerce.number().int().min(1000).max(3_600_000).default(DEFAULT_RUNNER_TURN_MS),
  AGENT_RUNNER_MAX_OUTPUT_BYTES: z.coerce.number().int().min(65_536).max(16_777_216).default(DEFAULT_RUNNER_OUTPUT_BYTES),
  AGENT_CODEX_AUTH: z.enum(['codex-login', 'chatgpt-plan']).default('codex-login'),
  AGENT_CHATGPT_APP_NAME: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/).default('personal_agent'),
  AGENT_APP_TITLE: z.string().min(1).max(100).default('Personal Agent'),
  AGENT_CHATGPT_PROFILE_DIR: z.string().min(1).optional(),
  AGENT_CODEX_COMMAND: z.string().default('codex'),
  AGENT_CODEX_MODEL: z.string().optional(),
  AGENT_CODEX_KNOWLEDGE_TOOLS: z.enum(['disabled', 'experimental']).default('disabled'),
  AGENT_ALLOWED_ORIGINS: z.string().default(''),
});
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const result = Environment.safeParse(env);
  if (!result.success) throw new Error('配置不完整或无效。请先运行 npm run setup，并检查 .env。');
  const c = result.data;
  if (c.AGENT_RUNTIME === 'remote' && (!c.AGENT_RUNNER_URL || !c.AGENT_RUNNER_AUTH_TOKEN || c.AGENT_RUNNER_AUTH_TOKEN === c.AGENT_AUTH_TOKEN)) {
    throw new Error('远程执行器需要地址和独立于设备访问密钥的授权密钥。');
  }
  if (c.AGENT_RUNTIME === 'remote' && c.AGENT_CODEX_KNOWLEDGE_TOOLS !== 'disabled') throw new Error('远程执行器暂不支持资料工具。');
  return { host: c.SERVER_HOST, port: c.SERVER_PORT, authToken: c.AGENT_AUTH_TOKEN,
    runnerUrl: c.AGENT_RUNTIME === 'remote' ? normalizeRunnerUrl(c.AGENT_RUNNER_URL!) : undefined,
    runnerToken: c.AGENT_RUNNER_AUTH_TOKEN, runnerTurnTimeoutMs: c.AGENT_RUNNER_TURN_TIMEOUT_MS, runnerMaxOutputBytes: c.AGENT_RUNNER_MAX_OUTPUT_BYTES,
    dataDir: resolve(c.AGENT_DATA_DIR), runtime: c.AGENT_RUNTIME, command: c.AGENT_CODEX_COMMAND,
    authMode: c.AGENT_CODEX_AUTH, planAppName: c.AGENT_CHATGPT_APP_NAME, appTitle: c.AGENT_APP_TITLE, planProfileDir: resolve(c.AGENT_CHATGPT_PROFILE_DIR ?? resolve(c.AGENT_DATA_DIR, 'plan-profile')),
    model: c.AGENT_CODEX_MODEL, knowledgeTools: c.AGENT_CODEX_KNOWLEDGE_TOOLS, allowedOrigins: c.AGENT_ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean) };
}
