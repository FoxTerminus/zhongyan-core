import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { NotificationBatchSchema, NotificationQuerySchema, ClearNotificationsSchema,
  type NotificationBatch, type NotificationBatchResult, type NotificationQuery, type NotificationRecord,
  type NotificationPage, type NotificationDeviceList } from '@personal-agent/contracts';
import { DomainError } from './errors.js';

const DAY_MS = 24 * 60 * 60_000;
export const NOTIFICATION_RETENTION_MS = 30 * DAY_MS;
export const NOTIFICATION_OFFLINE_MS = 7 * DAY_MS;
export const NOTIFICATION_FUTURE_MS = 5 * 60_000;
export const NOTIFICATION_MAX_RECORDS = 10_000;
export const NOTIFICATION_MAX_DEVICES = 100;
type Row = Record<string, unknown>;
const recordFrom = (row: Row): NotificationRecord => ({
  id: String(row.id), deviceId: String(row.device_id), eventId: String(row.event_id),
  packageName: String(row.package_name), appName: String(row.app_name), title: String(row.title),
  text: String(row.text), postedAt: String(row.posted_at), receivedAt: String(row.received_at),
});

/** Notification bodies are untrusted reference data. Storing or reading them does
 * not invoke models/tools or authorize a reply, action, credential use or send.
 * This database has one owner and is copied with agent_data by encrypted backup.
 */
export class NotificationStore {
  private db: DatabaseSync;
  constructor(path: string, private clock: () => number = Date.now) {
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA busy_timeout=1000; PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;');
      this.db.exec('BEGIN EXCLUSIVE; COMMIT;');
      const version = Number((this.db.prepare('PRAGMA user_version').get() as Row).user_version);
      if (version > 1) throw new Error('通知数据库版本高于当前程序，请升级程序。');
      if (version === 0) this.db.exec(`BEGIN;
        CREATE TABLE notifications(
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          device_id TEXT NOT NULL,
          event_id TEXT NOT NULL,
          package_name TEXT NOT NULL,
          app_name TEXT NOT NULL,
          title TEXT NOT NULL,
          text TEXT NOT NULL,
          posted_at TEXT NOT NULL,
          received_at TEXT NOT NULL,
          UNIQUE(device_id,event_id)
        );
        CREATE INDEX notifications_device_sequence ON notifications(device_id,seq DESC);
        CREATE INDEX notifications_received ON notifications(received_at);
        PRAGMA user_version=1;
        COMMIT;`);
      // A version flag alone must not make a damaged/empty database valid.
      this.db.prepare('SELECT seq,id,device_id,event_id,package_name,app_name,title,text,posted_at,received_at FROM notifications LIMIT 0').all();
      this.tx(() => this.prune(this.clock()));
    } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  private tx<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = action(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private prune(now: number) {
    this.db.prepare('DELETE FROM notifications WHERE received_at < ?').run(new Date(now - NOTIFICATION_RETENTION_MS).toISOString());
    this.db.prepare('DELETE FROM notifications WHERE seq IN (SELECT seq FROM notifications ORDER BY seq DESC LIMIT -1 OFFSET ?)').run(NOTIFICATION_MAX_RECORDS);
  }
  ingest(value: NotificationBatch): NotificationBatchResult {
    // Keep validation at the storage boundary for all future callers, not only HTTP.
    const input = NotificationBatchSchema.parse(value);
    const now = this.clock(), receivedAt = new Date(now).toISOString();
    return this.tx(() => {
      this.prune(now);
      const acceptedEventIds: string[] = [], duplicateEventIds: string[] = [];
      const hasDevice = this.db.prepare('SELECT 1 FROM notifications WHERE device_id=? LIMIT 1').get(input.deviceId);
      const deviceCount = Number(this.db.prepare('SELECT COUNT(DISTINCT device_id) AS count FROM notifications').get()!.count);
      if (!hasDevice && deviceCount >= NOTIFICATION_MAX_DEVICES) {
        throw new DomainError('notification_device_limit', '已达到通知设备记录上限，请先清除旧安装实例的通知记录。', 409);
      }
      for (const event of input.events) {
        const postedMs = Date.parse(event.postedAt), postedAt = new Date(postedMs).toISOString();
        const existing = this.db.prepare('SELECT * FROM notifications WHERE device_id=? AND event_id=?').get(input.deviceId, event.eventId) as Row | undefined;
        if (existing) {
          if (existing.package_name !== event.packageName || existing.app_name !== event.appName || existing.title !== event.title || existing.text !== event.text || existing.posted_at !== postedAt) {
            throw new DomainError('notification_idempotency_conflict', '通知事件标识已用于不同内容，本批次未保存。', 409);
          }
          duplicateEventIds.push(event.eventId);
          continue;
        }
        if (postedMs < now - NOTIFICATION_OFFLINE_MS || postedMs > now + NOTIFICATION_FUTURE_MS) {
          throw new DomainError('notification_time_invalid', '通知时间超出允许范围，请检查手机时间；仅接收最近 7 天的通知。');
        }
        this.db.prepare('INSERT INTO notifications(id,device_id,event_id,package_name,app_name,title,text,posted_at,received_at) VALUES(?,?,?,?,?,?,?,?,?)')
          .run(randomUUID(), input.deviceId, event.eventId, event.packageName, event.appName, event.title, event.text, postedAt, receivedAt);
        acceptedEventIds.push(event.eventId);
      }
      this.prune(now);
      return { acceptedEventIds, duplicateEventIds, receivedAt };
    });
  }
  list(value: NotificationQuery = { limit: 20 }): NotificationPage {
    const query = NotificationQuerySchema.parse(value);
    this.tx(() => this.prune(this.clock()));
    const predicates: string[] = [], parameters: Array<string | number> = [];
    if (query.deviceId) { predicates.push('device_id=?'); parameters.push(query.deviceId); }
    if (query.cursor) { predicates.push('seq<?'); parameters.push(query.cursor); }
    const where = predicates.length ? 'WHERE ' + predicates.join(' AND ') : '';
    const rows = this.db.prepare(`SELECT * FROM notifications ${where} ORDER BY seq DESC LIMIT ?`).all(...parameters, query.limit + 1) as Row[];
    const page = rows.slice(0, query.limit);
    return { notifications: page.map(recordFrom), nextCursor: rows.length > query.limit ? Number(page.at(-1)!.seq) : null };
  }
  devices(): NotificationDeviceList {
    this.tx(() => this.prune(this.clock()));
    const rows = this.db.prepare('SELECT device_id,COUNT(*) AS count,MAX(received_at) AS last_received_at FROM notifications GROUP BY device_id ORDER BY MAX(seq) DESC LIMIT ?')
      .all(NOTIFICATION_MAX_DEVICES) as Row[];
    return { devices: rows.map(row => ({ deviceId: String(row.device_id), count: Number(row.count), lastReceivedAt: String(row.last_received_at) })) };
  }
  clear(deviceId: string): { deleted: number } {
    const parsed = ClearNotificationsSchema.parse({ deviceId });
    return this.tx(() => {
      this.prune(this.clock());
      return { deleted: Number(this.db.prepare('DELETE FROM notifications WHERE device_id=?').run(parsed.deviceId).changes) };
    });
  }
}
