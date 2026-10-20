import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
await mkdir(new URL('.data/', root), { recursive: true });
await mkdir(new URL('.cache/', root), { recursive: true });
try {
  const template = await readFile(new URL('.env.example', root), 'utf8');
  const content = template.replace(/^AGENT_AUTH_TOKEN=.*$/m, `AGENT_AUTH_TOKEN=${randomBytes(32).toString('base64url')}`);
  await writeFile(new URL('.env', root), content, { flag: 'wx', mode: 0o600 });
  console.log('已生成本地配置和连接密钥，密钥仅保存在 .env。');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('现有 .env 已保留。');
}
console.log(`工程目录：${fileURLToPath(root)}`);
console.log('下一步：npm run dev:server。默认仅监听本机，模型保持未连接状态。');
