import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, copyFile, chmod } from 'node:fs/promises';
import { constants } from 'node:fs';

const directory = new URL('./', import.meta.url);
const secrets = new URL('.secrets/', directory);
await mkdir(secrets, { recursive: true, mode: 0o700 });
if (process.platform !== 'win32') await chmod(secrets, 0o700);
for (const name of ['agent-auth-token', 'runner-auth-token']) {
const secret = new URL(name, secrets);
try {
  // Compose's file secret keeps source ownership. A readable file inside a
  // private 0700 directory works for the non-root container without exposing
  // the host path to other users. Do not move it to a public directory.
  await writeFile(secret, `${randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o444 });
  console.log(`已生成 ${name} 独立密钥；内容未输出。`);
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log(`${name} 已存在，已保留。`);
}
}
try {
  await copyFile(new URL('deployment.env.example', directory),
    new URL('deployment.env', directory), constants.COPYFILE_EXCL);
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
}
console.log('请编辑 deploy/deployment.env 的公网地址和 TLS 模式，然后执行部署校验。未创建云资源。');
