import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { Conversation, Message, Task, TaskEvent, Effort } from '@personal-agent/contracts';
import { DomainError } from './errors.js';

type Row = Record<string, unknown>;
const now = () => new Date().toISOString();
const taskFrom = (r: Row): Task => ({ id: String(r.id), conversationId: String(r.conversation_id), status: r.status as Task['status'], effort: r.effort as Effort, createdAt: String(r.created_at), updatedAt: String(r.updated_at), error: r.error as string | null });
const messageFrom = (r: Row): Message => ({ id: String(r.id), conversationId: String(r.conversation_id), role: r.role as Message['role'], text: String(r.text), createdAt: String(r.created_at), taskId: r.task_id as string | null });
const conversationFrom = (r: Row): Conversation => ({ id: String(r.id), title: String(r.title), createdAt: String(r.created_at), updatedAt: String(r.updated_at) });

/** SQLite owns lifecycle state. Agent history is an optional external resource. */
export class Store {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    try {
    // This personal service has one worker owner per database. OS-backed locks
    // are released on a crash; a second instance cannot recover live tasks.
    this.db.exec('PRAGMA busy_timeout=1000; PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
    this.db.exec('BEGIN EXCLUSIVE; COMMIT;');
    const version = Number((this.db.prepare('PRAGMA user_version').get() as Row).user_version);
    if (version > 1) throw new Error('数据库版本高于当前程序，请升级程序。');
    if (version === 0) this.db.exec(`BEGIN;
      CREATE TABLE conversations(id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, thread_id TEXT);
      CREATE TABLE tasks(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), request_id TEXT NOT NULL, text TEXT NOT NULL, effort TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, error TEXT, UNIQUE(conversation_id, request_id));
      CREATE TABLE messages(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), role TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL, task_id TEXT REFERENCES tasks(id));
      CREATE UNIQUE INDEX one_assistant_per_task ON messages(task_id) WHERE role='assistant';
      CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id), type TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX events_task_cursor ON events(task_id,id);
      CREATE INDEX tasks_queue ON tasks(status,created_at);
      PRAGMA user_version=1;
      COMMIT;`);
    } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  createConversation(title = '新的对话'): Conversation {
    const id = randomUUID(), stamp = now();
    this.db.prepare('INSERT INTO conversations(id,title,created_at,updated_at) VALUES(?,?,?,?)').run(id, title, stamp, stamp);
    return this.getConversation(id);
  }
  getConversation(id: string): Conversation {
    const row = this.db.prepare('SELECT * FROM conversations WHERE id=?').get(id) as Row | undefined;
    if (!row) throw new DomainError('not_found', '找不到这个对话。', 404);
    return conversationFrom(row);
  }
  listConversations(): Conversation[] { return (this.db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC').all() as Row[]).map(conversationFrom); }
  snapshot(id: string) { return { conversation: this.getConversation(id), messages: this.messages(id), tasks: (this.db.prepare('SELECT * FROM tasks WHERE conversation_id=? ORDER BY rowid').all(id) as Row[]).map(taskFrom) }; }
  messages(id: string): Message[] { return (this.db.prepare("SELECT m.* FROM messages m LEFT JOIN tasks t ON t.id=m.task_id WHERE m.conversation_id=? ORDER BY t.rowid, CASE m.role WHEN 'user' THEN 0 ELSE 1 END, m.rowid").all(id) as Row[]).map(messageFrom); }
  historyBeforeTask(id: string): Pick<Message, 'role' | 'text'>[] {
    const task = this.getTask(id);
    const rows = this.db.prepare(`SELECT m.role,m.text FROM messages m JOIN tasks t ON t.id=m.task_id
      WHERE t.conversation_id=? AND t.rowid<(SELECT rowid FROM tasks WHERE id=?)
      AND t.status='completed' AND m.text<>''
      ORDER BY t.rowid, CASE m.role WHEN 'user' THEN 0 ELSE 1 END, m.rowid`).all(task.conversationId, id) as Row[];
    return rows.slice(-100).map(r => ({ role: r.role as Message['role'], text: String(r.text) }));
  }
  threadId(id: string): string | null { return (this.db.prepare('SELECT thread_id FROM conversations WHERE id=?').get(id) as Row).thread_id as string | null; }
  setThreadId(id: string, threadId: string) { this.db.prepare('UPDATE conversations SET thread_id=? WHERE id=?').run(threadId, id); }
  enqueue(conversationId: string, text: string, requestId: string, effort: Effort) {
    return this.tx(() => {
      this.getConversation(conversationId);
      const existing = this.db.prepare('SELECT * FROM tasks WHERE conversation_id=? AND request_id=?').get(conversationId, requestId) as Row | undefined;
      if (existing) {
        if (existing.text !== text || existing.effort !== effort) throw new DomainError('idempotency_conflict', '该发送标识已用于另一条消息。', 409);
        return { task: taskFrom(existing), message: messageFrom(this.db.prepare("SELECT * FROM messages WHERE task_id=? AND role='user'").get(String(existing.id)) as Row) };
      }
      const id = randomUUID(), messageId = randomUUID(), stamp = now();
      this.db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,NULL)').run(id, conversationId, requestId, text, effort, 'queued', stamp, stamp);
      this.db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?)').run(messageId, conversationId, 'user', text, stamp, id);
      this.db.prepare("UPDATE conversations SET updated_at=?, title=CASE WHEN title='新的对话' THEN ? ELSE title END WHERE id=?").run(stamp, text.slice(0, 36), conversationId);
      this.appendEvent(id, 'status', { status: 'queued' });
      return { task: this.getTask(id), message: messageFrom(this.db.prepare('SELECT * FROM messages WHERE id=?').get(messageId) as Row) };
    });
  }
  getTask(id: string): Task {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as Row | undefined;
    if (!row) throw new DomainError('not_found', '找不到这个任务。', 404);
    return taskFrom(row);
  }
  taskText(id: string): string { return String((this.db.prepare('SELECT text FROM tasks WHERE id=?').get(id) as Row).text); }
  claimNext(): Task | undefined {
    return this.tx(() => {
      const row = this.db.prepare("SELECT * FROM tasks WHERE status='queued' ORDER BY rowid LIMIT 1").get() as Row | undefined;
      if (!row) return;
      const task = taskFrom(row);
      this.db.prepare("UPDATE tasks SET status='running',updated_at=? WHERE id=? AND status='queued'").run(now(), task.id);
      this.db.prepare('INSERT OR IGNORE INTO messages VALUES(?,?,?,?,?,?)').run(randomUUID(), task.conversationId, 'assistant', '', now(), task.id);
      this.appendEvent(task.id, 'status', { status: 'running' });
      return this.getTask(task.id);
    });
  }
  appendEvent(taskId: string, type: string, data: unknown) {
    this.db.prepare('INSERT INTO events(task_id,type,data,created_at) VALUES(?,?,?,?)').run(taskId, type, JSON.stringify(data), now());
  }
  appendText(taskId: string, text: string) {
    this.tx(() => {
      if (this.getTask(taskId).status !== 'running') return;
      this.db.prepare("UPDATE messages SET text=text||? WHERE task_id=? AND role='assistant'").run(text, taskId);
      this.appendEvent(taskId, 'message_delta', { text });
    });
  }
  finish(id: string, status: Task['status'], error: string | null = null): Task {
    return this.tx(() => {
      const current = this.getTask(id);
      // Cancellation wins against a late completion notification.
      if (current.status !== 'running' && current.status !== 'queued') return current;
      this.db.prepare('UPDATE tasks SET status=?,error=?,updated_at=? WHERE id=?').run(status, error, now(), id);
      this.db.prepare('UPDATE conversations SET updated_at=? WHERE id=?').run(now(), current.conversationId);
      this.appendEvent(id, 'status', { status });
      if (error) this.appendEvent(id, 'error', { message: error });
      return this.getTask(id);
    });
  }
  cancel(id: string): Task {
    const current = this.getTask(id);
    if (current.status === 'cancelled') return current;
    if (['completed', 'failed', 'interrupted'].includes(current.status)) {
      throw new DomainError('invalid_state', '任务已结束，无需取消。', 409);
    }
    if (current.status === 'waiting_for_input') {
      return this.tx(() => {
        this.db.prepare("UPDATE tasks SET status='cancelled',error=NULL,updated_at=? WHERE id=?").run(now(), id);
        this.appendEvent(id, 'status', { status: 'cancelled' });
        return this.getTask(id);
      });
    }
    return this.finish(id, 'cancelled');
  }
  retry(id: string): Task {
    return this.tx(() => {
      const task = this.getTask(id);
      if (!['failed', 'interrupted', 'waiting_for_input'].includes(task.status)) throw new DomainError('invalid_state', '只有失败、等待处理或中断的任务可以重试。', 409);
      this.db.prepare("DELETE FROM messages WHERE task_id=? AND role='assistant'").run(id);
      this.db.prepare("UPDATE tasks SET status='queued',error=NULL,updated_at=? WHERE id=?").run(now(), id);
      this.appendEvent(id, 'status', { status: 'queued' });
      return this.getTask(id);
    });
  }
  recoverInterrupted() {
    const running = this.db.prepare("SELECT id FROM tasks WHERE status='running'").all() as Row[];
    for (const row of running) this.finish(String(row.id), 'interrupted', '执行服务重启，任务已保存。请核对后重试。');
  }
  events(taskId: string, after: number) {
    this.getTask(taskId);
    const events: TaskEvent[] = (this.db.prepare('SELECT * FROM events WHERE task_id=? AND id>? ORDER BY id LIMIT 200').all(taskId, after) as Row[]).map(r => ({ id: Number(r.id), taskId: String(r.task_id), type: String(r.type), data: JSON.parse(String(r.data)), createdAt: String(r.created_at) }));
    return { events, nextCursor: events.at(-1)?.id ?? after };
  }
}
