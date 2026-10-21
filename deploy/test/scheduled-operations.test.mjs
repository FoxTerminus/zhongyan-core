import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, readdir, lstat, symlink } from 'node:fs/promises';
import { join, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { backupDue, maintenanceIdle, atomicJson, exclusive, verifiedAutomaticBackups, retainAutomaticBackups, healthSummary, runBackup, runHealth } from '../scheduled-operations.mjs';
import { units, unitPath, ensureDirectory } from '../install-schedule.mjs';
import { VOLUMES, digest } from '../operations.mjs';
import { withStoppedServices } from '../backup.mjs';

const directory = fileURLToPath(new URL('../', import.meta.url));
async function fixture(t) {
  const base = await mkdtemp(join(directory, '.scheduled-test-'));
  t.after(async () => {
    const path = await realpath(base), child = relative(await realpath(directory), path);
    assert.ok(child && !isAbsolute(child) && child !== '..' && !child.startsWith('..' + sep));
    await rm(path, { recursive: true, force: true });
  });
  const stateDirectory = join(base, 'state'), backupDirectory = join(base, 'backups');
  await mkdir(stateDirectory); await mkdir(backupDirectory, { mode: 0o700 });
  return { root: base, stateDirectory, backupDirectory, recipient: join(base, 'recipient'), hourUtc: 20, minuteUtc: 30 };
}
const NOW = Date.parse('2026-10-21T20:35:00Z');
async function readState(config, name = 'backup.json') { return JSON.parse(await readFile(join(config.stateDirectory, name), 'utf8')); }
async function idle(config, busy = false) {
  const gate = await readState(config, 'maintenance.json');
  return { schemaVersion: 1, maintenance: { active: true, operationId: gate.operationId, expiresAt: gate.expiresAt }, idle: { queued: busy ? 1 : 0, running: 0, workerBusy: false } };
}
async function absent(path) { await assert.rejects(lstat(path), { code: 'ENOENT' }); }
async function fakeArchive(directory, index, options = {}) {
  const createdAt = new Date(NOW - index * 86400_000).toISOString();
  const name = 'auto-v1-' + createdAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z') + '-' + randomUUID();
  const path = join(directory, name); await mkdir(path, { mode: 0o700 });
  await writeFile(join(path, 'snapshot.tar.gz.age'), 'synthetic encrypted fixture only');
  const manifest = { version: 1, createdAt, archive: 'snapshot.tar.gz.age', archiveBytes: (await lstat(join(path, 'snapshot.tar.gz.age'))).size,
    snapshotBytes: 20, sha256: await digest(join(path, 'snapshot.tar.gz.age')), volumes: VOLUMES.map(logical => ({ logical })), services: [{ service: 'server', image: 'sha256:' + 'b'.repeat(64) }] };
  await writeFile(join(path, 'manifest.json'), JSON.stringify(manifest));
  if (options.corrupt) await writeFile(join(path, 'snapshot.tar.gz.age'), 'corrupted');
  if (options.extra) await writeFile(join(path, 'keep-me'), 'unknown');
  return path;
}
test('daily due time catches missed days and returns bootstrap backup to next planned slot', () => {
  assert.equal(backupDue(null, NOW), true);
  assert.equal(backupDue('2026-10-21T20:31:00Z', NOW), false);
  assert.equal(backupDue('2026-10-20T20:34:00Z', NOW), true);
  assert.equal(backupDue('2026-10-20T21:34:00Z', NOW), true);
  assert.equal(backupDue('2026-10-20T20:31:00Z', Date.parse('2026-10-21T12:00:00Z')), false);
  assert.equal(backupDue('2026-10-21T12:00:00Z', NOW), true);
  assert.throws(() => backupDue('invalid', NOW));
  assert.throws(() => backupDue('2027-10-21T20:31:00Z', NOW));
});
test('gate acknowledgement requires exact id, supported protocol, all idle signals', () => {
  const value = { schemaVersion: 1, maintenance: { active: true, operationId: 'expected', expiresAt: new Date(Date.now() + 600_000).toISOString() }, idle: { queued: 0, running: 0, workerBusy: false } };
  assert.equal(maintenanceIdle(value, 'expected'), true);
  assert.equal(maintenanceIdle(value, 'other'), false);
  for (const field of ['queued', 'running', 'workerBusy']) assert.equal(maintenanceIdle({ ...value, idle: { ...value.idle, [field]: 1 } }, 'expected'), false);
  assert.equal(maintenanceIdle({ ...value, schemaVersion: 2 }, 'expected'), false);
  assert.equal(maintenanceIdle({ ...value, idle: {} }, 'expected'), false);
});
test('busy task defers automatic backup without stopping services, gate is removed', async t => {
  const config = await fixture(t); let called = false;
  const result = await runBackup(config, { now: () => NOW, idle: () => idle(config, true), backup: async () => { called = true; } });
  assert.deepEqual(result, { ok: true, status: 'deferred' }); assert.equal(called, false);
  assert.equal((await readState(config)).lastSuccessAt, null);
  assert.equal((await readdir(config.backupDirectory)).length, 0);
  await absent(join(config.stateDirectory, 'maintenance.json'));
});
test('idle is rechecked after preflight; a newly queued task still prevents service stop', async t => {
  const config = await fixture(t); let calls = 0, stopped = false;
  const result = await runBackup(config, { now: () => NOW, idle: () => idle(config, ++calls > 1), backup: async (_root, _output, _recipient, hooks) => {
    await hooks.beforeStop(); stopped = true;
  } });
  assert.equal(result.status, 'deferred'); assert.equal(calls, 2); assert.equal(stopped, false);
  await absent(join(config.stateDirectory, 'maintenance.json'));
});
test('completed backup clears gate before encryption completes and records success before retention', async t => {
  const config = await fixture(t); let retentionCalls = 0;
  const result = await runBackup(config, { now: () => NOW, idle: () => idle(config), backup: async (_root, _output, _recipient, hooks) => {
    await hooks.beforeStop(); await hooks.afterRestart();
    await absent(join(config.stateDirectory, 'maintenance.json'));
    return { createdAt: new Date(NOW).toISOString(), archiveBytes: 20, sha256: 'c'.repeat(64) };
  }, retention: async () => { retentionCalls++; assert.equal((await readState(config)).status, 'ok'); return { retainedCount: 1, rejectedCount: 0 }; } });
  assert.equal(result.status, 'ok'); assert.equal(retentionCalls, 1); assert.equal((await readState(config)).lastSuccessAt, new Date(NOW).toISOString());
  await absent(join(config.stateDirectory, '.backup-lock'));
  assert.equal((await runBackup(config, { now: () => NOW, idle: () => { throw new Error(); } })).status, 'not-due');
});
test('copy failure keeps prior successful backup and produces sanitized persistent failure', async t => {
  const config = await fixture(t), lastSuccessAt = '2026-10-18T20:31:00Z';
  await atomicJson(config.stateDirectory, 'backup.json', { schemaVersion: 1, status: 'ok', lastSuccessAt });
  let retained = false;
  const result = await runBackup(config, { now: () => NOW, idle: () => idle(config), backup: async (_root, _output, _recipient, hooks) => { await hooks.beforeStop(); throw new Error('SECRET DETAIL'); }, retention: async () => { retained = true; } });
  assert.equal(result.status, 'failed'); assert.equal(retained, false);
  const saved = await readState(config); assert.equal(saved.lastSuccessAt, lastSuccessAt); assert.equal(saved.status, 'failed');
  assert.equal(JSON.stringify(saved).includes('SECRET'), false); await absent(join(config.stateDirectory, 'maintenance.json'));
});
test('retention failure preserves valid newly completed backup with visible warning', async t => {
  const config = await fixture(t);
  const result = await runBackup(config, { now: () => NOW, idle: () => idle(config), backup: async () => ({ createdAt: new Date(NOW).toISOString(), archiveBytes: 20, sha256: 'b'.repeat(64) }), retention: async () => { throw new Error('synthetic'); } });
  assert.equal(result.status, 'retention-failed'); const saved = await readState(config); assert.equal(saved.status, 'ok'); assert.equal(saved.retentionWarning, true); assert.ok(saved.lastSuccessAt);
});
test('failed readiness and existing foreign gate never start backup or delete foreign gate', async t => {
  const config = await fixture(t); let called = false;
  assert.equal((await runBackup(config, { now: () => NOW, idle: async () => { throw new Error('SECRET'); }, backup: async () => { called = true; } })).status, 'failed');
  const foreign = { schemaVersion: 1, operationId: randomUUID(), startedAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 60000).toISOString(), reason: 'backup' };
  await atomicJson(config.stateDirectory, 'maintenance.json', foreign);
  assert.equal((await runBackup(config, { now: () => NOW, idle: async () => { throw new Error(); }, backup: async () => { called = true; } })).status, 'failed');
  assert.deepEqual(await readState(config, 'maintenance.json'), foreign); assert.equal(called, false);
});
test('exclusive scheduler refuses a concurrent or unexplained stale lock', async t => {
  const config = await fixture(t);
  await exclusive(config.stateDirectory, '.backup-lock', async () => {
    assert.deepEqual(await runBackup(config, { now: () => NOW }), { ok: false, status: 'locked' });
  });
  await absent(join(config.stateDirectory, '.backup-lock'));
});
test('retention deletes only verified controlled archives after verifying newest; keeps manual and damaged data', async t => {
  const config = await fixture(t), paths = [];
  for (let index = 0; index < 9; index++) paths.push(await fakeArchive(config.backupDirectory, index));
  const bad = await fakeArchive(config.backupDirectory, 12, { corrupt: true }), extra = await fakeArchive(config.backupDirectory, 13, { extra: true });
  const manual = join(config.backupDirectory, 'initial-manual'); await mkdir(manual); await writeFile(join(manual, 'keep'), 'precious');
  await assert.rejects(retainAutomaticBackups(config.backupDirectory, bad));
  assert.equal((await readdir(config.backupDirectory)).length, 12);
  assert.deepEqual(await retainAutomaticBackups(config.backupDirectory, paths[0]), { retainedCount: 7, rejectedCount: 2 });
  for (const path of paths.slice(0, 7)) assert.ok((await lstat(path)).isDirectory());
  for (const path of paths.slice(7)) await absent(path);
  for (const path of [bad, extra, manual]) assert.ok((await lstat(path)).isDirectory());
});
test('atomic status writer rejects arbitrary names and leaves no temporary files', async t => {
  const config = await fixture(t);
  await assert.rejects(atomicJson(config.stateDirectory, '../outside', {}));
  for (let i = 0; i < 3; i++) await atomicJson(config.stateDirectory, 'health.json', { schemaVersion: 1, value: i });
  assert.equal((await readState(config, 'health.json')).value, 2);
  assert.deepEqual(await readdir(config.stateDirectory), ['health.json']);
  if (process.platform !== 'win32') assert.equal((await lstat(join(config.stateDirectory, 'health.json'))).mode & 0o777, 0o644);
});
test('real POSIX symlinks are never followed or deleted during retention/status writes', { skip: process.platform === 'win32' }, async t => {
  const config = await fixture(t), newest = await fakeArchive(config.backupDirectory, 0);
  const outside = join(config.root, 'outside'); await mkdir(outside, { mode: 0o700 }); await writeFile(join(outside, 'keep'), 'safe');
  await symlink(outside, join(config.backupDirectory, 'auto-v1-20261019T000000Z-' + randomUUID()));
  const checked = await verifiedAutomaticBackups(config.backupDirectory); assert.equal(checked.rejected.length, 1);
  await retainAutomaticBackups(config.backupDirectory, newest); assert.equal(await readFile(join(outside, 'keep'), 'utf8'), 'safe');
  await symlink(join(outside, 'keep'), join(config.stateDirectory, 'health.json'));
  await assert.rejects(atomicJson(config.stateDirectory, 'health.json', {})); assert.equal(await readFile(join(outside, 'keep'), 'utf8'), 'safe');
});
function healthyReport(hours) {
  return { checkedAt: new Date(NOW).toISOString(), checks: ['disk', 'runner', 'server', 'proxy', 'address', 'https-api'].map(name => ({ name, ok: true, detail: 'SECRET' })).concat({ name: 'certificate', ok: hours >= 48, detail: { expiresAt: new Date(NOW + hours * 3_600_000).toISOString(), remainingHours: hours } }) };
}
test('certificate thresholds distinguish 48h warning, 24h critical, and missing inspection', () => {
  for (const [hours, severity] of [[72, 'ok'], [48, 'ok'], [47.9, 'warning'], [24, 'warning'], [23.9, 'critical'], [0, 'critical']]) {
    const summary = healthSummary(healthyReport(hours)); assert.equal(summary.checks.find(check => check.name === 'tls').severity, severity);
    assert.equal(JSON.stringify(summary).includes('SECRET'), false); assert.equal(summary.certificate.remainingHours, hours);
  }
  const missing = healthSummary({ checkedAt: new Date(NOW).toISOString(), checks: [] }); assert.equal(missing.ok, false); assert.equal(missing.checks.length, 4);
});
test('unhandled health failure publishes unavailable state without leaking exception', async t => {
  const config = await fixture(t);
  assert.equal((await runHealth(config, { health: async () => { throw new Error('SECRET'); } })).ok, false);
  const saved = await readState(config, 'health.json'); assert.equal(saved.ok, false); assert.equal(saved.checks.length, 4); assert.equal(JSON.stringify(saved).includes('SECRET'), false);
});
test('restored-services hook clears gate even when copying fails', async () => {
  const calls = [];
  await assert.rejects(withStoppedServices([{ id: 'one', running: true, service: 'server' }], async (_cmd, args) => { calls.push(args[0]); return args[0] === 'inspect' ? 'false' : ''; }, async () => { throw new Error('copy'); }, async () => { calls.push('release'); }), /copy/);
  assert.deepEqual(calls, ['stop', 'inspect', 'start', 'release']);
});
test('systemd units are UTC, bounded, opt-in, and never start another runner', () => {
  const config = { root: '/opt/zhongyan/app', stateDirectory: '/opt/zhongyan/operations', backupDirectory: '/opt/zhongyan/backups' };
  const result = units(config, '/etc/zhongyan/operations.json', '/usr/local/bin/node');
  assert.equal(Object.keys(result).length, 4);
  assert.match(result['zhongyan-health.timer'], /\*:00\/5:00 UTC/);
  assert.match(result['zhongyan-backup.timer'], /\*:00\/15:00 UTC/);
  assert.match(result['zhongyan-backup.service'], /TimeoutStartSec=90min/);
  assert.equal(JSON.stringify(result).includes('compose up'), false);
  for (const path of ['/opt/a b', '/opt/a%h', '/opt/a\nb', '/opt/../etc']) assert.throws(() => unitPath(path));
});

test('Linux installer defeats umask077 only for newly created state directory', { skip: process.platform !== 'linux' || process.getuid?.() !== 0 }, async t => {
  const config = await fixture(t), publicState = join(config.root, 'public-state'), existing = join(config.root, 'existing-state');
  const mask = process.umask(0o077);
  try {
    await ensureDirectory(publicState, 0o755);
    assert.equal((await lstat(publicState)).mode & 0o777, 0o755);
    await mkdir(existing, { mode: 0o700 });
    await assert.rejects(ensureDirectory(existing, 0o755));
    assert.equal((await lstat(existing)).mode & 0o777, 0o700);
  } finally { process.umask(mask); }
});
