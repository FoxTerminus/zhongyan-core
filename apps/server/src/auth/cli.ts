import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { FilePlanProfileStore } from './profile-store.js';
import { authorizePlanProfile } from './loopback.js';
import { importPlanProfile, readTransferredProfile } from './profile-transfer.js';
import { StoredPlanCredentialProvider } from './provider.js';
import { PlanOAuth } from './oauth.js';
import { PLAN_APP, PlanAuthError } from './types.js';

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ options: {
    help: { type: 'boolean' }, 'profile-dir': { type: 'string' }, 'open-source-ready': { type: 'boolean' },
  }, allowPositionals: true });
  if (values.help || positionals.length === 0) {
    console.log('用法：node dist/auth/cli.js <login|prepare-host|status|import-stdin> [--profile-dir <独立目录>]');
    console.log('login 和 import-stdin 需要 --open-source-ready：确认本应用已符合官方开源客户端条件。');
    console.log('prepare-host 仅初始化稳定主机身份；status 只读，不续期、不推理。');
    console.log('login 在同一台计算机浏览器完成授权；import-stdin 仅接收通过 SSH 安全迁移的本应用 profile.json，不读取桌面登录。');
    return;
  }
  const command = positionals[0];
  if (positionals.length !== 1 || !command || !['login', 'prepare-host', 'status', 'import-stdin'].includes(command)) {
    throw new PlanAuthError('invalid_response', '未知授权管理命令。');
  }
  if (['login', 'import-stdin'].includes(command) && !values['open-source-ready']) {
    throw new PlanAuthError('sign_in_required', '开始前请确认应用符合官方开源客户端条件，并显式传入 --open-source-ready。');
  }
  const directory = resolve(values['profile-dir'] ?? process.env.AGENT_CHATGPT_PROFILE_DIR
    ?? resolve(process.env.AGENT_DATA_DIR ?? '.data', 'plan-profile'));
  const store = new FilePlanProfileStore(directory);
  if (command === 'prepare-host') {
    await store.hostId(); console.log('已准备此主机的独立身份；没有登录或调用模型。'); return;
  }
  if (command === 'status') {
    console.log(JSON.stringify(await new StoredPlanCredentialProvider(store).inspect())); return;
  }
  if (command === 'import-stdin') {
    if (process.stdin.isTTY) throw new PlanAuthError('invalid_response', '请通过受保护文件重定向 stdin，不在交互终端粘贴凭据。');
    const timeout = setTimeout(() => process.stdin.destroy(new PlanAuthError('cancelled', '迁移输入已超时。')), 30_000);
    try {
      await importPlanProfile(await readTransferredProfile(process.stdin), store, process.env.AGENT_CHATGPT_APP_NAME ?? PLAN_APP.name);
      console.log('本应用授权已导入，保留了目标主机身份。后续刷新由此主机负责；尚未验证实际推理。');
    } finally { clearTimeout(timeout); }
    return;
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    await authorizePlanProfile(store, {
      signal: controller.signal,
      onReady(url) {
        console.log('Continue with ChatGPT：在本机浏览器打开以下官方链接完成本应用独立授权。');
        console.log(url); // Contains no access/refresh token or optional identity hint.
      },
    }, new PlanOAuth({ appName: process.env.AGENT_CHATGPT_APP_NAME }));
    console.log('本应用的独立授权已保存。尚未验证模型推理权限；启动服务时仍需显式选择 chatgpt-plan。');
  } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}
await main().catch(error => {
  console.error(error instanceof PlanAuthError ? error.message : '授权管理失败，请检查参数、专用目录权限和是否有其他授权进程。');
  process.exitCode = 1;
});
