import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, realpath, readFile, link } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative, isAbsolute, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { VOLUMES, createPrivateDirectory, checkPrivateDirectoryOwner, digest, withCancellation, command } from '../operations.mjs';
import { withStoppedServices } from '../backup.mjs';
import { validateManifest, verifyDatabases, extractionArguments, tarExtractionArguments, removeRestoreContainer } from '../restore.mjs';
import { healthyContainer, checkHealth } from '../check-health.mjs';

const directory = fileURLToPath(new URL('../', import.meta.url));
async function fixture(t) {
  const parent = await mkdtemp(join(directory, '.operations-test-'));
  t.after(async () => {
    const path = await realpath(parent), child = relative(await realpath(directory), path);
    assert.ok(child && !isAbsolute(child) && child !== '..' && !child.startsWith('..' + sep));
    await rm(path, { recursive: true, force: true });
  });
  return parent;
}
async function databases(t) {
  const parent = await fixture(t), data = join(parent, 'volumes/agent_data');
  await mkdir(data, { recursive: true });
  const schemas = {
    'agent.sqlite': `
      CREATE TABLE conversations(id TEXT PRIMARY KEY, title TEXT, created_at TEXT, updated_at TEXT, thread_id TEXT);
      CREATE TABLE tasks(id TEXT PRIMARY KEY, conversation_id TEXT REFERENCES conversations(id), request_id TEXT, text TEXT, effort TEXT, status TEXT, created_at TEXT, updated_at TEXT, error TEXT);
      CREATE TABLE messages(id TEXT PRIMARY KEY, conversation_id TEXT REFERENCES conversations(id), role TEXT, text TEXT, created_at TEXT, task_id TEXT REFERENCES tasks(id));
      CREATE TABLE events(id INTEGER PRIMARY KEY, task_id TEXT REFERENCES tasks(id), type TEXT, data TEXT, created_at TEXT);
      INSERT INTO conversations(id,title) VALUES('synthetic-conversation','synthetic');`,
    'knowledge.sqlite': `
      CREATE TABLE notes(id TEXT PRIMARY KEY, title TEXT, body TEXT, source TEXT, revision INTEGER, created_at TEXT, updated_at TEXT);
      CREATE TABLE note_revisions(note_id TEXT REFERENCES notes(id), revision INTEGER, title TEXT, body TEXT, source TEXT, created_at TEXT, updated_at TEXT);
      CREATE VIRTUAL TABLE notes_fts USING fts5(title,body,source,content='notes',content_rowid='rowid',tokenize='trigram');`,
  };
  for (const [name, schema] of Object.entries(schemas)) {
    const db = new DatabaseSync(join(data, name)); db.exec(schema + ' PRAGMA user_version=1;'); db.close();
  }
  return { parent, data };
}
const services = [
  { service: 'runner', id: 'runner-id', running: true },
  { service: 'server', id: 'server-id', running: true },
  { service: 'proxy', id: 'proxy-id', running: false },
];
function fakeCommands(fail) {
  const calls = [];
  return { calls, async run(_command, args) {
    const operation = args[0], id = args.at(-1);
    calls.push([operation, id]);
    if (fail?.(operation, id)) throw new Error('synthetic failure');
    return operation === 'inspect' ? 'false' : '';
  } };
}
test('consistent copy runs only after all services stop and restores exactly previous running services', async () => {
  const mock = fakeCommands();
  const result = await withStoppedServices(services, mock.run, async () => { mock.calls.push(['copy']); return 'snapshot'; });
  assert.equal(result, 'snapshot');
  assert.deepEqual(mock.calls, [['stop', 'server-id'], ['stop', 'runner-id'], ['inspect', 'runner-id'], ['inspect', 'server-id'], ['inspect', 'proxy-id'], ['copy'], ['start', 'runner-id'], ['start', 'server-id']]);
});
test('failed stop or copy still attempts restart of every originally running service', async () => {
  for (const duringStop of [true, false]) {
    const mock = fakeCommands(operation => duringStop && operation === 'stop');
    await assert.rejects(withStoppedServices(services, mock.run, async () => { throw new Error('synthetic copy failure'); }));
    assert.deepEqual(mock.calls.slice(-2), [['start', 'runner-id'], ['start', 'server-id']]);
  }
});
test('one failed restart does not prevent attempts to restore remaining services', async () => {
  const mock = fakeCommands((operation, id) => operation === 'start' && id === 'runner-id');
  await assert.rejects(withStoppedServices(services, mock.run, async () => true), /恢复原运行状态失败：runner/);
  assert.deepEqual(mock.calls.slice(-2), [['start', 'runner-id'], ['start', 'server-id']]);
});
test('refuses copying when a service is still running', async () => {
  let copied = false; const mock = fakeCommands();
  await assert.rejects(withStoppedServices(services, async (command, args) => args[0] === 'inspect' ? 'true' : mock.run(command, args), async () => { copied = true; }), /仍有服务/);
  assert.equal(copied, false);
  assert.deepEqual(mock.calls.slice(-2), [['start', 'runner-id'], ['start', 'server-id']]);
});
test('output directory creation refuses an existing destination without overwriting', async t => {
  const parent = await fixture(t), path = join(parent, 'backup');
  await createPrivateDirectory(path); await writeFile(join(path, 'keep'), 'existing');
  await assert.rejects(createPrivateDirectory(path));
  assert.equal(await readFile(join(path, 'keep'), 'utf8'), 'existing');
});
test('source secrets accept exactly the deployment owner while root outputs stay root-owned', () => {
  const source = { uid: 1000, mode: 0o40700 }, rootOutput = { uid: 0, mode: 0o40700 };
  assert.doesNotThrow(() => checkPrivateDirectoryOwner(source, 1000));
  assert.doesNotThrow(() => checkPrivateDirectoryOwner(rootOutput, 0));
  assert.throws(() => checkPrivateDirectoryOwner(source, 0));
  assert.throws(() => checkPrivateDirectoryOwner(rootOutput, 1000));
  assert.throws(() => checkPrivateDirectoryOwner({ ...source, uid: 1001 }, 1000));
  for (const mode of [0o40750, 0o40777, 0o40600]) assert.throws(() => checkPrivateDirectoryOwner({ ...source, mode }, 1000));
  for (const uid of [undefined, -1, NaN]) assert.throws(() => checkPrivateDirectoryOwner(source, uid));
});
test('manifest requires complete known volumes, bounded sizes and an image digest', () => {
  const valid = { version: 1, archive: 'snapshot.tar.gz.age', archiveBytes: 20, snapshotBytes: 100,
    sha256: 'a'.repeat(64), volumes: VOLUMES.map(logical => ({ logical })), services: [{ service: 'server', image: 'sha256:' + 'b'.repeat(64) }] };
  assert.equal(validateManifest(valid), valid);
  for (const invalid of [{ ...valid, archive: '../escape' }, { ...valid, volumes: valid.volumes.slice(1) },
    { ...valid, snapshotBytes: Number.MAX_SAFE_INTEGER }, { ...valid, services: [] }, { ...valid, sha256: 'bad' }]) assert.throws(() => validateManifest(invalid));
});
test('checksum changes when an encrypted-file fixture is corrupted', async t => {
  const parent = await fixture(t), path = join(parent, 'synthetic.age');
  await writeFile(path, 'synthetic ciphertext A'); const before = await digest(path);
  await writeFile(path, 'synthetic ciphertext B'); assert.notEqual(await digest(path), before);
});
test('real SQLite copies are checked and corruption fails before claiming restore readiness', async t => {
  const { parent, data } = await databases(t);
  await verifyDatabases(parent);
  await writeFile(join(data, 'knowledge.sqlite'), 'corrupted fixture');
  await assert.rejects(verifyDatabases(parent));
});
test('empty, wrong-version and incomplete business databases are not restore-ready', async t => {
  const { parent, data } = await databases(t), path = join(data, 'agent.sqlite');
  for (const version of [0, 2]) {
    const db = new DatabaseSync(path); db.exec('PRAGMA user_version=' + version); db.close();
    await assert.rejects(verifyDatabases(parent), /版本不兼容/);
  }
  const db = new DatabaseSync(path); db.exec('PRAGMA user_version=1; DROP TABLE events;'); db.close();
  await assert.rejects(verifyDatabases(parent), /业务表或列/);
  await writeFile(path, ''); // An empty SQLite file can pass integrity_check but has no business data.
  await assert.rejects(verifyDatabases(parent));
});
test('foreign key corruption is rejected even when SQLite physical integrity passes', async t => {
  const { parent, data } = await databases(t);
  const db = new DatabaseSync(join(data, 'agent.sqlite'));
  db.exec("PRAGMA foreign_keys=OFF; INSERT INTO events(task_id,type,data) VALUES('missing-task','status','{}');");
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok'); db.close();
  await assert.rejects(verifyDatabases(parent), /外键检查失败/);
});
test('restored SQLite sidecars must be unlinked ordinary files', async t => {
  const { parent, data } = await databases(t), original = join(parent, 'unrelated');
  await writeFile(original, 'synthetic sidecar'); await link(original, join(data, 'agent.sqlite-wal'));
  await assert.rejects(verifyDatabases(parent), /非链接的普通文件/);
});
test('restore cleanup distinguishes automatic removal from real Docker cleanup failure', async () => {
  const calls = [];
  await removeRestoreContainer('owned-restore', async (_tool, args) => { calls.push(args); return ''; });
  assert.equal(calls.length, 1); assert.equal(calls[0].at(-1), 'name=^/owned-restore$');
  calls.length = 0;
  await removeRestoreContainer('owned-restore', async (_tool, args) => { calls.push(args); return args[0] === 'ps' ? 'synthetic-id' : ''; });
  assert.deepEqual(calls[1], ['rm', '--force', 'owned-restore']);
  await assert.rejects(removeRestoreContainer('owned-restore', async (_tool, args) => {
    if (args[0] === 'rm') throw new Error('synthetic failure'); return 'synthetic-id';
  }), /无法确认隔离恢复容器已清理/);
  let inspections = 0;
  await removeRestoreContainer('owned-restore', async (_tool, args) => {
    if (args[0] === 'rm') throw new Error('already removed');
    return inspections++ === 0 ? 'synthetic-id' : '';
  });
  assert.equal(inspections, 2);
});
test('cancellation interrupts active subprocess but allows cleanup before removing signal handlers', async () => {
  const events = new EventEmitter(); let cleaned = false;
  await assert.rejects(withCancellation(async (signal, checkCancellation) => {
    try {
      const work = command(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], 30000, signal);
      events.emit('SIGINT'); events.emit('SIGTERM');
      await work; checkCancellation();
    } finally { cleaned = true; assert.equal(events.listenerCount('SIGINT'), 1); }
  }, events));
  assert.equal(cleaned, true); assert.equal(events.listenerCount('SIGINT'), 0); assert.equal(events.listenerCount('SIGTERM'), 0);
});
test('failed command reports exit code without arguments or raw stdout/stderr', async () => {
  await assert.rejects(command(process.execPath, ['-e', "process.stdout.write('PRIVATE_FIXTURE'); process.stderr.write('PRIVATE_FIXTURE'); process.exit(23)"]), error => {
    assert.match(error.message, /退出码 23/); assert.ok(!error.message.includes('PRIVATE_FIXTURE'));
    assert.ok(!error.message.includes('process.exit')); return true;
  });
});
test('restore extraction uses isolated local image and only archive/empty-target binds', () => {
  const args = extractionArguments('sha256:' + 'a'.repeat(64), '/backup/archive.tar.gz', '/backup/new/contents', 'synthetic-restore');
  assert.ok(args.includes('none')); assert.ok(args.includes('--read-only'));
  assert.equal(args[args.indexOf('--pull') + 1], 'never');
  const binds = args.filter((_, i) => args[i - 1] === '--mount');
  assert.deepEqual(binds, ['type=bind,src=/backup/archive.tar.gz,dst=/archive.tar.gz,readonly', 'type=bind,src=/backup/new/contents,dst=/restore']);
  assert.equal(args[args.indexOf('--entrypoint') + 1], 'tar');
  assert.ok(!args.some(value => value.includes('docker.sock') || value.includes('profile') || value.includes('AGENT_AUTH')));
});
test('real GNU tar extracts a synthetic archive and refuses overwriting an existing file', { skip: process.platform !== 'linux' }, async t => {
  assert.match(await command('tar', ['--version']), /GNU tar/);
  const parent = await fixture(t), source = join(parent, 'source'), contents = join(parent, 'contents'), archive = join(parent, 'synthetic.tar.gz');
  await mkdir(source, { mode: 0o700 }); await mkdir(contents, { mode: 0o700 });
  await mkdir(join(source, 'nested'), { mode: 0o700 });
  await writeFile(join(source, 'nested/value'), 'archive original', { mode: 0o600 });
  await command('tar', ['-czf', archive, '-C', source, '.']);
  await command('tar', tarExtractionArguments(archive, contents));
  const extracted = join(contents, 'nested/value');
  assert.equal(await readFile(extracted, 'utf8'), 'archive original');
  await writeFile(extracted, 'existing file must survive');
  await assert.rejects(command('tar', tarExtractionArguments(archive, contents)), /退出码 2/);
  assert.equal(await readFile(extracted, 'utf8'), 'existing file must survive');
});
test('health requires real healthy state rather than merely a started API process', () => {
  assert.equal(healthyContainer({ running: true, health: 'healthy' }, true), true);
  for (const health of ['starting', 'unhealthy', null]) assert.equal(healthyContainer({ running: true, health }, true), false);
  assert.equal(healthyContainer({ running: false, health: 'healthy' }, true), false);
  assert.equal(healthyContainer({ running: true, health: null }, false), true);
});
test('health uses no credentials/model calls and reports oversized responses as failure', async t => {
  const parent = await fixture(t); await mkdir(join(parent, 'deploy'));
  await writeFile(join(parent, 'deploy/deployment.env'), 'AGENT_TLS_MODE=ip\nAGENT_DOMAIN=8.8.8.8\n');
  const requested = [];
  const dependencies = {
    space: async () => {}, command: async (_name, args) => args[0] === 'compose' ? 'a'.repeat(64) : JSON.stringify({ running: true, health: 'healthy' }),
    tls: async () => ({ ok: true, expiresAt: '2099-01-01T00:00:00Z', remainingHours: 100 }),
    fetch: async (url, options) => { requested.push({ url, options }); return new Response(JSON.stringify({ status: 'ok', protocolVersion: 1 })); },
  };
  const report = await checkHealth(parent, dependencies); assert.equal(report.ok, true);
  assert.equal(requested.length, 1); assert.equal(requested[0].url, 'https://8.8.8.8/health');
  assert.equal(requested[0].options.headers, undefined);
  const failed = await checkHealth(parent, { ...dependencies, fetch: async () => new Response('x'.repeat(5000)) });
  assert.equal(failed.ok, false); assert.equal(failed.checks.find(check => check.name === 'https-api').ok, false);
});
