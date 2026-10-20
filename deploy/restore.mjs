import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { OperationsError, VOLUMES, requireLinuxRoot, command, withCancellation, ordinaryFile, realDirectory, privateDirectory, createPrivateDirectory, checkSpace, digest } from './operations.mjs';

// Compatibility contract, not migrations: never create missing tables in a restored copy.
// Update alongside Store/KnowledgeStore migrations; reject newer versions explicitly.
const DATABASES = {
  'agent.sqlite': {
    conversations: ['id', 'title', 'created_at', 'updated_at', 'thread_id'],
    tasks: ['id', 'conversation_id', 'request_id', 'text', 'effort', 'status', 'created_at', 'updated_at', 'error'],
    messages: ['id', 'conversation_id', 'role', 'text', 'created_at', 'task_id'],
    events: ['id', 'task_id', 'type', 'data', 'created_at'],
  },
  'knowledge.sqlite': {
    notes: ['id', 'title', 'body', 'source', 'revision', 'created_at', 'updated_at'],
    note_revisions: ['note_id', 'revision', 'title', 'body', 'source', 'created_at', 'updated_at'],
    notes_fts: ['title', 'body', 'source'],
  },
};

export function validateManifest(value) {
  if (!value || value.version !== 1 || value.archive !== 'snapshot.tar.gz.age'
      || !/^[a-f0-9]{64}$/.test(value.sha256) || !Number.isSafeInteger(value.archiveBytes) || value.archiveBytes <= 0
      || !Number.isSafeInteger(value.snapshotBytes) || value.snapshotBytes <= 0
      || value.snapshotBytes > Number.MAX_SAFE_INTEGER / 3
      || !Array.isArray(value.volumes) || value.volumes.map(item => item?.logical).sort().join(',') !== [...VOLUMES].sort().join(',')) {
    throw new OperationsError('备份清单格式或卷范围不兼容。');
  }
  const image = value.services?.find(item => item.service === 'server')?.image;
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new OperationsError('备份未记录有效的服务镜像摘要。');
  return value;
}
export async function verifyDatabases(contents) {
  const { DatabaseSync } = await import('node:sqlite');
  const directory = await realDirectory(join(contents, 'volumes/agent_data'));
  for (const [filename, tables] of Object.entries(DATABASES)) {
    const path = join(directory, filename);
    await ordinaryFile(path);
    for (const suffix of ['-wal', '-shm', '-journal']) {
      try { await ordinaryFile(path + suffix); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout=1000; PRAGMA query_only=ON;');
      if (db.prepare('PRAGMA user_version').get().user_version !== 1) throw new OperationsError('恢复副本的 SQLite 版本不兼容，请使用对应版本工具。');
      for (const [table, required] of Object.entries(tables)) {
        const type = db.prepare('SELECT type FROM sqlite_schema WHERE name=?').get(table)?.type;
        const columns = db.prepare('SELECT name FROM pragma_table_info(?)').all(table).map(row => row.name);
        if (type !== 'table' || required.some(column => !columns.includes(column))) throw new OperationsError('恢复副本缺少必需的业务表或列。');
      }
      const rows = db.prepare('PRAGMA integrity_check').all();
      if (rows.length !== 1 || Object.values(rows[0])[0] !== 'ok') throw new OperationsError('恢复副本的 SQLite 完整性检查失败。');
      if (db.prepare('PRAGMA foreign_key_check').get()) throw new OperationsError('恢复副本的 SQLite 外键检查失败。');
    } finally { db.close(); }
  }
}
export async function removeRestoreContainer(name, run = command) {
  const inspect = () => run('docker', ['ps', '--all', '--quiet', '--filter', 'name=^/' + name + '$']);
  try {
    if (await inspect()) {
      try { await run('docker', ['rm', '--force', name], 15_000); }
      catch { if (await inspect()) throw new OperationsError('容器仍存在。'); } // --rm can win the race.
    }
  } catch { throw new OperationsError('无法确认隔离恢复容器已清理：' + name + '。未声明恢复成功，请检查 Docker。'); }
}
export function tarExtractionArguments(archive, contents) {
  // GNU tar rejects combining --keep-old-files with --no-overwrite-dir.
  // The caller creates a fresh target; keep-old-files additionally refuses file collisions.
  return ['-xzf', archive, '-C', contents, '--numeric-owner', '--keep-old-files'];
}
export function extractionArguments(image, archive, contents, name) {
  // No source volumes, host root, credentials, network, or Docker socket enter this sandbox.
  return ['run', '--rm', '--name', name, '--pull', 'never', '--network', 'none', '--read-only', '--user', '0:0',
    '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--cap-add', 'FOWNER', '--cap-add', 'DAC_OVERRIDE',
    '--security-opt', 'no-new-privileges:true', '--pids-limit', '64', '--memory', '256m',
    '--mount', 'type=bind,src=' + archive + ',dst=/archive.tar.gz,readonly',
    '--mount', 'type=bind,src=' + contents + ',dst=/restore', '--entrypoint', 'tar', image,
    ...tarExtractionArguments('/archive.tar.gz', '/restore')];
}
export async function restoreBackup(backupValue, outputValue, identityValue, imageOverride) {
  requireLinuxRoot(); process.umask(0o077);
  const backup = await privateDirectory(backupValue);
  const output = resolve(outputValue), identity = resolve(identityValue);
  if ([backup, output, identity].some(value => value.includes(','))) throw new OperationsError('路径不能含逗号，以免 Docker mount 解析歧义。');
  await privateDirectory(dirname(output));
  const identityStat = await ordinaryFile(identity, 64 * 1024);
  if (identityStat.uid !== process.getuid() || (identityStat.mode & 0o777) !== 0o600) throw new OperationsError('age 私钥必须属于当前用户且权限为 0600。');
  await ordinaryFile(join(backup, 'manifest.json'), 64 * 1024);
  const manifest = validateManifest(JSON.parse(await readFile(join(backup, 'manifest.json'), 'utf8')));
  const encrypted = join(backup, manifest.archive);
  if ((await ordinaryFile(encrypted)).size !== manifest.archiveBytes || await digest(encrypted) !== manifest.sha256) throw new OperationsError('备份文件大小或 SHA256 不匹配，未解密。');
  const image = imageOverride ?? manifest.services.find(item => item.service === 'server').image;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:/@-]+$/.test(image)) throw new OperationsError('恢复辅助镜像引用无效。');
  await command('docker', ['image', 'inspect', '--format', '{{.Id}}', image]);
  await command('age', ['--version']);
  await checkSpace(dirname(output), manifest.snapshotBytes * 2 + 64 * 1024 * 1024);
  await createPrivateDirectory(output);
  const archive = join(output, '.snapshot.tar.gz'), contents = join(output, 'contents');
  const containerName = 'zhongyan-restore-' + randomUUID();
  await mkdir(contents, { mode: 0o700 });
  return withCancellation(async (signal, checkCancellation) => {
    let result;
    try {
      // age authenticates the ciphertext; the private key stays in a protected file.
      await command('age', ['--decrypt', '-i', identity, '-o', archive, encrypted], 600_000, signal);
      checkCancellation();
      try { await command('docker', extractionArguments(image, archive, contents, containerName), 600_000, signal); }
      finally {
        // A timed-out docker client does not stop its daemon-owned container.
        // Cleanup must not inherit the cancelled work signal.
        await removeRestoreContainer(containerName);
      }
      checkCancellation();
      for (const name of VOLUMES) await realDirectory(join(contents, 'volumes', name));
      await verifyDatabases(contents);
      checkCancellation();
      result = { ok: true, offline: true, sqliteIntegrity: 'ok', sqliteSchema: 'compatible', sqliteForeignKeys: 'ok', sourceCreatedAt: manifest.createdAt,
        warnings: ['尚未替换线上卷或启动应用。', '旧备份中的轮转 refresh token 可能已失效；新主机必须准备自己的 host ID。',
          '恢复演练不得启动第二个使用同一授权的 runner。'] };
    } finally { await unlink(archive).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    checkCancellation();
    // A ready marker also certifies that the temporary plaintext archive was removed.
    await writeFile(join(output, 'RESTORE-READY.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return result;
  });
}
async function main() {
  const { values } = parseArgs({ options: { help: { type: 'boolean' }, backup: { type: 'string' }, out: { type: 'string' }, identity: { type: 'string' }, image: { type: 'string' } } });
  if (values.help || !values.backup || !values.out || !values.identity) {
    console.log('node deploy/restore.mjs --backup <备份目录> --out <全新恢复目录> --identity <age私钥文件> [--image <本地辅助镜像>]\n仅离线解密、隔离解包及 SQLite 完整性检查；不覆盖线上卷，不启动模型。父目录须0700，私钥0600。');
    if (!values.help) process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(await restoreBackup(values.backup, values.out, values.identity, values.image), null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  console.error(error instanceof OperationsError ? error.message : '恢复失败；隔离副本可能不完整，未修改线上服务。请检查权限、镜像、空间和工具。');
  process.exitCode = 1;
});
