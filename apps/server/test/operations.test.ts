import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';
import { OperationsStatusSchema } from '@personal-agent/contracts';
import { createApp } from '../src/app.js';
import { OperationsReader, HEALTH_STALE_MS, BACKUP_STALE_MS } from '../src/operations.js';
import { Store } from '../src/store.js';
import { DisabledRuntime } from '../src/runtime/unavailable.js';
import type { AgentRuntime } from '../src/runtime/types.js';

const root = fileURLToPath(new URL('../../../work/operations-tests/', import.meta.url));
const AUTH = 'test-only-operations-token-0123456789abcdef';
const headers = { authorization: `Bearer ${AUTH}` };
const idle = { queued: 0, running: 0, workerBusy: false };
const fixedNow = Date.parse('2026-10-21T12:00:00.000Z');
const stamp = (offset = 0) => new Date(fixedNow + offset).toISOString();
const gate = (now = fixedNow) => ({ schemaVersion: 1, reason: 'backup', operationId: randomUUID(), startedAt: new Date(now).toISOString(), expiresAt: new Date(now + 15 * 60_000).toISOString() });
const healthy = () => ({ schemaVersion: 1, checkedAt: stamp(), ok: true,
  checks: ['api', 'tls', 'services', 'disk'].map(name => ({ name, ok: true, severity: 'ok', code: 'healthy' })),
  certificate: { expiresAt: stamp(5 * 24 * 3_600_000), remainingHours: 120 } });
const backedUp = () => ({ schemaVersion: 1, lastAttemptAt: stamp(), lastSuccessAt: stamp(), status: 'ok', retainedCount: 2,
  archive: { createdAt: stamp(), archiveBytes: 123456, sha256: 'a'.repeat(64) } });

describe('sanitized host operational status', { concurrency: false }, () => {
  const directories: string[] = [];
  function fixture() {
    mkdirSync(root, { recursive: true });
    const directory = mkdtempSync(join(root, 'reports-'));
    directories.push(directory);
    return { directory, reader: new OperationsReader(directory, () => fixedNow),
      write(name: string, data: unknown) { writeFileSync(join(directory, name), JSON.stringify(data)); } };
  }
  afterEach(() => {
    for (const directory of directories.splice(0)) {
      const safeRoot = realpathSync(root), target = realpathSync(directory), descendant = relative(safeRoot, target);
      assert.ok(descendant && !isAbsolute(descendant) && descendant !== '..' && !descendant.startsWith(`..${sep}`));
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('distinguishes unconfigured, missing and inaccessible reports without exposing paths', () => {
    const unconfigured = new OperationsReader(undefined, () => fixedNow).snapshot(idle);
    assert.equal(unconfigured.configured, false);
    assert.equal(unconfigured.health.code, 'unconfigured');
    assert.equal(unconfigured.backup.code, 'unconfigured');
    assert.equal(unconfigured.maintenance.active, false);
    const { directory, reader } = fixture();
    const missing = reader.snapshot(idle);
    assert.equal(missing.configured, true);
    assert.equal(missing.health.code, 'missing');
    assert.equal(missing.backup.code, 'missing');
    assert.equal(missing.maintenance.active, false);
    const inaccessible = new OperationsReader(join(directory, 'PRIVATE-PATH')).snapshot(idle);
    assert.equal(inaccessible.health.code, 'invalid');
    assert.equal(inaccessible.maintenance.active, true);
    assert.ok(!JSON.stringify(inaccessible).includes('PRIVATE-PATH'));
    assert.ok(OperationsStatusSchema.safeParse(unconfigured).success);
    assert.ok(OperationsStatusSchema.safeParse(missing).success);
  });

  it('returns only validated allowlisted metadata and computes live certificate lifetime', () => {
    const { reader, write } = fixture();
    write('health.json', { ...healthy(), path: 'PRIVATE-PATH', token: AUTH, detail: 'RAW-LOG' });
    write('backup.json', { ...backedUp(), lastError: AUTH, file: 'PRIVATE-PATH', secret: 'RAW-LOG' });
    const status = reader.snapshot(idle);
    assert.ok(OperationsStatusSchema.safeParse(status).success);
    assert.equal(status.health.state, 'ok');
    assert.equal(status.health.certificate?.remainingHours, 120);
    assert.equal(status.backup.state, 'ok');
    for (const secret of [AUTH, 'PRIVATE-PATH', 'RAW-LOG', 'a'.repeat(64)]) assert.ok(!JSON.stringify(status).includes(secret));
  });

  it('detects stale health and backup records instead of reporting old success as current', () => {
    const { reader, write } = fixture();
    write('health.json', { ...healthy(), checkedAt: stamp(-HEALTH_STALE_MS - 1) });
    write('backup.json', { ...backedUp(), lastAttemptAt: stamp(-BACKUP_STALE_MS - 1), lastSuccessAt: stamp(-BACKUP_STALE_MS - 1) });
    assert.equal(reader.snapshot(idle).health.code, 'stale');
    assert.equal(reader.snapshot(idle).backup.code, 'stale');
  });

  it('presents backup failure, first deferred attempt and stalled work honestly', () => {
    const { reader, write } = fixture();
    write('backup.json', { ...backedUp(), status: 'failed', lastError: AUTH });
    assert.equal(reader.snapshot(idle).backup.state, 'error');
    write('backup.json', { ...backedUp(), status: 'deferred', lastSuccessAt: null });
    assert.equal(reader.snapshot(idle).backup.code, 'deferred');
    write('backup.json', { ...backedUp(), status: 'running' });
    assert.equal(reader.snapshot(idle).backup.code, 'running');
    write('backup.json', { ...backedUp(), status: 'running', lastAttemptAt: stamp(-2 * 3_600_000 - 1) });
    assert.equal(reader.snapshot(idle).backup.code, 'stalled');
    write('backup.json', { ...backedUp(), lastSuccessAt: null });
    assert.equal(reader.snapshot(idle).backup.code, 'invalid');
  });

  it('rejects malformed, oversized and future-dated status without reflecting input', () => {
    const { reader, write, directory } = fixture();
    for (const data of [{ ...healthy(), checkedAt: stamp(120_000) }, { ...healthy(), schemaVersion: 99 },
      { ...healthy(), checks: [...healthy().checks.slice(0, 3), healthy().checks[0]] }]) {
      write('health.json', data);
      assert.equal(reader.snapshot(idle).health.code, 'invalid');
    }
    writeFileSync(join(directory, 'health.json'), AUTH + '{');
    assert.equal(reader.snapshot(idle).health.code, 'invalid');
    writeFileSync(join(directory, 'health.json'), 'x'.repeat(65 * 1024));
    assert.equal(reader.snapshot(idle).health.code, 'invalid');
    write('backup.json', { ...backedUp(), lastSuccessAt: stamp(120_000) });
    assert.equal(reader.snapshot(idle).backup.code, 'invalid');
  });

  it('reports an expired certificate even when its recorded remaining hours were positive', () => {
    const { reader, write } = fixture();
    write('health.json', { ...healthy(), certificate: { expiresAt: stamp(-1000), remainingHours: 120 } });
    const result = reader.snapshot(idle).health;
    assert.equal(result.state, 'error');
    assert.equal(result.checks.find(check => check.name === 'tls')?.code, 'expired');
    assert.ok(result.certificate!.remainingHours < 0);
  });

  it('keeps an expiring certificate warning and a retention problem visible without claiming success', () => {
    const { reader, write } = fixture();
    const report = healthy();
    report.ok = false;
    report.checks[1] = { name: 'tls', ok: false, severity: 'warning', code: 'expiring' };
    write('health.json', report);
    assert.equal(reader.snapshot(idle).health.state, 'warning');
    for (const warning of [{ retentionWarning: true }, { rejectedCount: 1 }]) {
      write('backup.json', { ...backedUp(), ...warning });
      assert.equal(reader.snapshot(idle).backup.state, 'warning');
      assert.equal(reader.snapshot(idle).backup.code, 'retention_warning');
    }
    write('backup.json', { ...backedUp(), archive: { ...backedUp().archive, createdAt: stamp(120_000) } });
    assert.equal(reader.snapshot(idle).backup.code, 'invalid');
  });

  it('enforces a valid lease and automatically unlocks an expired lease', () => {
    const { reader, write } = fixture();
    const active = gate();
    write('maintenance.json', active);
    assert.equal(reader.maintenance().state, 'active');
    assert.equal(reader.maintenance().operationId, active.operationId);
    assert.throws(() => reader.assertAcceptingTasks(), { code: 'maintenance', statusCode: 503 });
    write('maintenance.json', gate(fixedNow - 16 * 60_000));
    assert.equal(reader.maintenance().state, 'expired');
    assert.equal(reader.maintenance().active, false);
    assert.doesNotThrow(() => reader.assertAcceptingTasks());
  });

  it('fails closed on malformed or unbounded maintenance rather than trusting unknown files', () => {
    const { reader, write, directory } = fixture();
    for (const data of [null, { ...gate(), operationId: AUTH }, { ...gate(), expiresAt: stamp(2 * 3_600_000) },
      { ...gate(), startedAt: stamp(120_000) }, { ...gate(), expiresAt: stamp(-1000) }]) {
      write('maintenance.json', data);
      assert.equal(reader.maintenance().state, 'invalid');
      assert.throws(() => reader.assertAcceptingTasks(), { code: 'maintenance' });
      assert.ok(!JSON.stringify(reader.maintenance()).includes(AUTH));
    }
    writeFileSync(join(directory, 'maintenance.json'), '{');
    assert.equal(reader.maintenance().active, true);
  });

  it('does not follow symlink reports on POSIX', { skip: process.platform === 'win32' ? 'Windows symlink privileges are not assumed' : false }, () => {
    const { directory, reader } = fixture();
    writeFileSync(join(directory, 'private.json'), JSON.stringify(healthy()));
    symlinkSync(join(directory, 'private.json'), join(directory, 'health.json'));
    assert.equal(reader.snapshot(idle).health.code, 'invalid');
  });

  it('authenticates status, rejects arbitrary file selectors, blocks enqueue/retry while allowing reads/cancel', async () => {
    const { directory, write } = fixture();
    const store = new Store(join(directory, 'test.sqlite'));
    const app = createApp({ store, runtime: new DisabledRuntime(), authToken: AUTH, operationsDir: directory, startWorker: false });
    try {
      const conversation = store.createConversation();
      const first = store.enqueue(conversation.id, 'pending', randomUUID(), 'low');
      const retryable = store.enqueue(conversation.id, 'failed', randomUUID(), 'low');
      store.finish(retryable.task.id, 'failed');
      const before = store.snapshot(conversation.id);
      assert.equal((await app.inject('/v1/operations')).statusCode, 401);
      assert.equal((await app.inject({ url: '/v1/operations?path=PRIVATE-PATH', headers })).statusCode, 400);
      write('maintenance.json', gate(Date.now()));
      const status = (await app.inject({ url: '/v1/operations', headers })).json();
      assert.equal(status.maintenance.active, true);
      assert.deepEqual(status.idle, { queued: 1, running: 0, workerBusy: false });
      const send = () => app.inject({ method: 'POST', url: `/v1/conversations/${conversation.id}/messages`, headers,
        payload: { text: 'new', clientRequestId: randomUUID() } });
      assert.equal((await send()).statusCode, 503);
      assert.equal((await app.inject({ method: 'POST', url: `/v1/tasks/${retryable.task.id}/retry`, headers })).statusCode, 503);
      assert.deepEqual(store.snapshot(conversation.id), before);
      assert.equal((await app.inject({ url: `/v1/conversations/${conversation.id}`, headers })).statusCode, 200);
      assert.equal((await app.inject({ method: 'POST', url: `/v1/tasks/${first.task.id}/cancel`, headers })).statusCode, 200);
      write('maintenance.json', gate(Date.now() - 16 * 60_000));
      assert.equal((await send()).statusCode, 202);
      assert.equal((await app.inject({ method: 'POST', url: `/v1/tasks/${retryable.task.id}/retry`, headers })).statusCode, 200);
    } finally { await app.close(); }
  });

  it('never reports idle while an aborted runtime has not settled, even if database tasks are terminal', async () => {
    const { directory, write } = fixture();
    let finish: () => void = () => {};
    const runtime: AgentRuntime = {
      getStatus: async () => ({ provider: 'test-only', available: true, authenticated: true, message: 'test', models: [] }),
      run: async () => { await new Promise<void>(resolve => { finish = resolve; }); },
      close: async () => { finish(); },
    };
    const store = new Store(join(directory, 'worker.sqlite'));
    const app = createApp({ store, runtime, authToken: AUTH, operationsDir: directory });
    try {
      const conversation = store.createConversation();
      const sent = await app.inject({ method: 'POST', url: `/v1/conversations/${conversation.id}/messages`, headers,
        payload: { text: 'test-only runtime', clientRequestId: randomUUID() } });
      const task = sent.json().task;
      write('maintenance.json', gate(Date.now()));
      await app.inject({ method: 'POST', url: `/v1/tasks/${task.id}/cancel`, headers });
      const busy = (await app.inject({ url: '/v1/operations', headers })).json();
      assert.deepEqual(busy.idle, { queued: 0, running: 0, workerBusy: true });
      finish();
      await new Promise(resolve => setImmediate(resolve));
      const settled = (await app.inject({ url: '/v1/operations', headers })).json();
      assert.deepEqual(settled.idle, idle);
    } finally { finish(); await app.close(); }
  });
});
