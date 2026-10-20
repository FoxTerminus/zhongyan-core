import { loadSecret } from './read-secret.mjs';

// Separate image entrypoints never discover desktop credentials or print secrets.
try {
  const argumentsValue = process.argv.slice(2);
  if (argumentsValue.length > 1 || (argumentsValue.length && argumentsValue[0] !== '--runner')) {
    throw new Error('Unknown entrypoint.');
  }
  if (argumentsValue[0] === '--runner') {
    // The runner must never receive the public API's device authentication key.
    if (process.env.AGENT_AUTH_TOKEN || process.env.AGENT_AUTH_TOKEN_FILE) throw new Error('Unexpected device key.');
    await loadSecret(process.env, 'AGENT_RUNNER_AUTH_TOKEN');
    await import('../apps/server/dist/runner/main.js');
  } else {
    await loadSecret(process.env, 'AGENT_AUTH_TOKEN');
    await loadSecret(process.env, 'AGENT_RUNNER_AUTH_TOKEN');
    await import('../apps/server/dist/main.js');
  }
} catch {
  console.error('服务启动失败：请检查独立密钥文件、数据卷权限和环境配置。');
  process.exitCode = 1;
}
