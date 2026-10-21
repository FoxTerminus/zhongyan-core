import { mkdir, copyFile, writeFile, rm, rmdir, lstat } from 'node:fs/promises';
import { resolve, dirname, join, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { OperationsError, CONFIG_FILES, requireLinuxRoot, command, discovery, recipient, realDirectory, privateDirectory, createPrivateDirectory, ordinaryFile, checkSpace, digest, encryptedArchive } from './operations.mjs';

/** Always attempt to restart every originally running service, even after stop/copy errors. */
export async function withStoppedServices(services, run, snapshot, afterRestart = async () => {}) {
  const running = services.filter(item => item.running);
  let result, failure;
  try {
    for (const item of [...running].reverse()) await run('docker', ['stop', '--time', '30', item.id], 40_000);
    for (const item of services) {
      if (await run('docker', ['inspect', '--format', '{{.State.Running}}', item.id]) !== 'false') throw new OperationsError('仍有服务在写入，已停止备份。');
    }
    result = await snapshot();
  } catch (error) { failure = error; }
  const startFailures = [];
  for (const item of running) {
    try { await run('docker', ['start', item.id], 30_000); }
    catch { startFailures.push(item.service); }
  }
  if (startFailures.length) throw new OperationsError('恢复原运行状态失败：' + startFailures.join(', ') + '。请立即检查；备份可能未完成。');
  await afterRestart();
  if (failure) throw failure;
  return result;
}
function below(parent, target) {
  const path = relative(parent, target);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('../'));
}
export async function backupDeployment(rootValue, outputValue, recipientFile, hooks = {}) {
  requireLinuxRoot();
  process.umask(0o077);
  const root = await realDirectory(rootValue), output = resolve(outputValue);
  await realDirectory(join(root, 'deploy'));
  // Source files can belong to the deploying account (e.g. ubuntu), not the root backup operator.
  // Only that exact source owner is accepted; output directories still require the current UID.
  await privateDirectory(join(root, 'deploy/.secrets'), { ownerUid: (await lstat(root)).uid });
  await privateDirectory(dirname(output));
  if (below(root, output)) throw new OperationsError('备份必须存放在源码目录之外，避免提交或递归复制。');
  await recipient(recipientFile);
  await command('age', ['--version']);
  await command('tar', ['--version']);
  const plan = await discovery(root);
  for (const volume of plan.volumes) {
    if (below(volume.path, output) || below(output, volume.path)) throw new OperationsError('备份输出与数据卷路径不能包含彼此。');
  }
  let bytes = 16 * 1024 * 1024;
  for (const volume of plan.volumes) {
    const size = Number((await command('du', ['-sb', '--', volume.path], 60_000)).split(/\s+/)[0]);
    if (!Number.isSafeInteger(size) || size < 0) throw new OperationsError('无法确定备份空间需求。');
    bytes += size;
  }
  for (const file of CONFIG_FILES) bytes += (await ordinaryFile(join(root, 'deploy', file), 1024 * 1024)).size;
  await checkSpace(dirname(output), bytes * 2 + 64 * 1024 * 1024);
  const lock = join(root, 'deploy/.operations-lock');
  await mkdir(lock, { mode: 0o700 }); // Refuse another operation or an unexplained stale lock.
  let cancelled = false;
  const cancel = () => { cancelled = true; };
  const checkCancellation = () => { if (cancelled) throw new OperationsError('备份已取消；已尝试恢复原运行服务。'); };
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  let stage;
  try {
    await createPrivateDirectory(output);
    stage = join(output, '.staging');
    await mkdir(stage, { mode: 0o700 });
    const metadata = { version: 1, createdAt: new Date().toISOString(), snapshotBytes: bytes,
      volumes: plan.volumes.map(({ logical, name }) => ({ logical, name })),
      services: plan.services.map(({ service, image, running }) => ({ service, image, running })),
      sourceHostMigration: 'Restore offline; a replacement VM needs its own application host identity.',
      credentialWarning: 'Rotating refresh tokens in older backups may no longer be valid.' };
    await hooks.beforeStop?.();
    await withStoppedServices(plan.services, command, async () => {
      checkCancellation();
      for (const volume of plan.volumes) {
        if (await command('docker', ['ps', '--filter', 'volume=' + volume.name, '--quiet'])) throw new OperationsError('持久卷仍被其他运行容器使用，未复制。');
      }
      await mkdir(join(stage, 'volumes'), { mode: 0o700 });
      for (const volume of plan.volumes) {
        checkCancellation();
        await command('cp', ['-a', '--', volume.path, join(stage, 'volumes', volume.logical)], 600_000);
      }
      await mkdir(join(stage, 'deployment/.secrets'), { recursive: true, mode: 0o700 });
      for (const file of CONFIG_FILES) await copyFile(join(root, 'deploy', file), join(stage, 'deployment', file));
      await writeFile(join(stage, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    }, hooks.afterRestart);
    checkCancellation();
    // Writers have resumed; encrypt the independent immutable copy.
    const archive = join(output, 'snapshot.tar.gz.age');
    await encryptedArchive(stage, archive, resolve(recipientFile));
    checkCancellation();
    const manifest = { ...metadata, archive: 'snapshot.tar.gz.age', archiveBytes: (await lstat(archive)).size, sha256: await digest(archive) };
    await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return { ok: true, createdAt: manifest.createdAt, archiveBytes: manifest.archiveBytes, sha256: manifest.sha256,
      note: '加密备份已生成；尚不代表已通过恢复演练，服务健康需另行检查。' };
  } finally {
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
    try { if (stage) await rm(stage, { recursive: true, force: true }); } // Exact newly created child only.
    finally { await rmdir(lock); }
  }
}
async function main() {
  const { values } = parseArgs({ options: { help: { type: 'boolean' }, root: { type: 'string' }, out: { type: 'string' }, recipient: { type: 'string' } } });
  if (values.help || !values.out || !values.recipient) {
    console.log('node deploy/backup.mjs --root <源码目录> --out <全新备份目录> --recipient <age公钥文件>\n需要 Linux root、Docker、GNU cp/tar/du、age。输出父目录须已存在且权限0700；停服复制后恢复原运行服务，仅输出非敏感摘要。');
    if (!values.help) process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(await backupDeployment(values.root ?? process.cwd(), values.out, values.recipient), null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  console.error(error instanceof OperationsError ? error.message : '备份失败；请检查目录权限、操作锁、磁盘和原服务状态。未输出原始错误或凭据。');
  process.exitCode = 1;
});
