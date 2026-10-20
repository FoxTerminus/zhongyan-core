import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { OPENAI_OIDC, PlanAuthError } from './types.js';

const execFileAsync = promisify(execFile);
const proxyVariables = new Set(['http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'node_use_env_proxy']);

export type SystemProxyEnvironmentOptions = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Injection for offline tests; the destination is always the fixed OAuth endpoint. */
  readProxy?: (targetUrl: string) => Promise<string | null>;
  proxyFlagSupported?: boolean;
};

async function readWindowsSystemProxy(targetUrl: string): Promise<string | null> {
  // Windows resolves its existing per-user configuration, including PAC and bypass.
  // The script contains only a fixed public endpoint; no settings or credentials are logged.
  const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  $target = [Uri]'${targetUrl}'
  $systemProxy = [System.Net.WebRequest]::GetSystemWebProxy()
  if ($null -eq $systemProxy -or $systemProxy.IsBypassed($target)) {
    [Console]::Out.Write('null')
    exit 0
  }
  $resolved = $systemProxy.GetProxy($target)
  if ($null -eq $resolved -or $resolved.Equals($target)) {
    [Console]::Out.Write('null')
    exit 0
  }
  if (($resolved.Scheme -ne 'http' -and $resolved.Scheme -ne 'https') -or $resolved.UserInfo) {
    exit 2
  }
  [Console]::Out.Write((ConvertTo-Json -InputObject $resolved.AbsoluteUri -Compress))
} catch {
  exit 1
}
`;
  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
    ], { encoding: 'utf8', timeout: 15_000, maxBuffer: 4096, windowsHide: true });
    const result: unknown = JSON.parse(stdout.trim());
    if (result === null || typeof result === 'string') return result;
  } catch { /* Raw process output may contain local settings; never propagate it. */ }
  throw new PlanAuthError('configuration', '无法安全解析当前 Windows 用户的系统代理，请检查现有代理设置后重试；没有改用直连。');
}

function validatedProxyUrl(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 2048 || /\s/.test(value)) {
    throw new PlanAuthError('configuration', '系统没有为 ChatGPT 授权地址解析出可用代理，可能未启用代理或命中旁路规则；没有改用直连。');
  }
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password
        || url.pathname !== '/' || url.search || url.hash) throw new Error('unsupported proxy');
    return url.href;
  } catch {
    throw new PlanAuthError('configuration', '系统代理必须是无内嵌账号密码的 HTTP(S) 代理地址；不支持的配置没有改用直连。');
  }
}

/** Return a child-only environment. Never modify the current process or OS settings. */
export async function createSystemProxyEnvironment(options: SystemProxyEnvironmentOptions = {}): Promise<NodeJS.ProcessEnv> {
  if ((options.platform ?? process.platform) !== 'win32') {
    throw new PlanAuthError('configuration', '自动读取系统代理目前只支持 Windows；此平台需要另行配置受支持的代理传输。');
  }
  if (!(options.proxyFlagSupported ?? process.allowedNodeEnvironmentFlags.has('--use-env-proxy'))) {
    throw new PlanAuthError('configuration', '当前 Node.js 不支持 --use-env-proxy，请更新到支持此功能的版本后再授权；没有改用直连。');
  }
  let rawProxy: string | null;
  try {
    rawProxy = await (options.readProxy ?? readWindowsSystemProxy)(OPENAI_OIDC.token);
  } catch {
    throw new PlanAuthError('configuration', '无法安全读取当前用户的系统代理，请检查现有代理设置后重试；没有改用直连。');
  }
  const proxyUrl = validatedProxyUrl(rawProxy);
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(options.env ?? process.env)) {
    if (!proxyVariables.has(name.toLowerCase())) environment[name] = value;
  }
  environment.HTTP_PROXY = proxyUrl;
  environment.HTTPS_PROXY = proxyUrl;
  environment.NODE_USE_ENV_PROXY = '1';
  // System bypass has already been evaluated for the fixed remote destination.
  // Do not inherit unrelated NO_PROXY entries that would silently skip this proxy.
  environment.NO_PROXY = '127.0.0.1,localhost,::1,[::1]';
  return environment;
}
