import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, copyFile, chmod, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function prepareDeployment(directory = new URL('./', import.meta.url), report = console.log) {
  const operations = new URL('.operations-state/', directory);
  try {
    await mkdir(operations, { mode: 0o755 });
    if (process.platform !== 'win32') await chmod(operations, 0o755);
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
  // Only sanitized status files belong here; refuse links or special destinations.
  const operationsStat = await lstat(operations);
  if (!operationsStat.isDirectory() || operationsStat.isSymbolicLink()) throw new Error('运维状态路径须为普通目录。');
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
      // Creation modes are masked by umask (e.g. root + 077 yields 0400).
      // Only this newly created file is changed; existing secrets retain their modes.
      if (process.platform !== 'win32') await chmod(secret, 0o444);
      report(`已生成 ${name} 独立密钥；内容未输出。`);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      report(`${name} 已存在，内容和文件权限已保留；请按预检结果检查容器可读权限。`);
    }
  }
  try {
    await copyFile(new URL('deployment.env.example', directory),
      new URL('deployment.env', directory), constants.COPYFILE_EXCL);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  report('请编辑 deploy/deployment.env 的公网地址和 TLS 模式，然后执行部署校验。未创建云资源。');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareDeployment();
}
