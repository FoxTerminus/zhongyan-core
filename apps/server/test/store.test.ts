import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Store } from '../src/store.js';
import { DomainError } from '../src/errors.js';

const workRoot = fileURLToPath(new URL('../../../work/', import.meta.url));
const testRoot = join(workRoot, 'store-tests');

function domainError(code: string, statusCode: number) {
  return (error: unknown) => error instanceof DomainError
    && error.code === code && error.statusCode === statusCode;
}

describe('SQLite task store', { concurrency: false }, () => {
  let directory: string;
  let databasePath: string;
  let store: Store;
  const openStores = new Set<Store>();

  function openStore(): Store {
    const opened = new Store(databasePath);
    openStores.add(opened);
    return opened;
  }

  function reopen(): void {
    openStores.delete(store);
    store.close();
    store = openStore();
  }

  beforeEach(() => {
    mkdirSync(testRoot, { recursive: true });
    directory = mkdtempSync(join(testRoot, 'store-'));
    databasePath = join(directory, 'state.sqlite');
    store = openStore();
  });

  afterEach(() => {
    for (const opened of openStores) opened.close();
    openStores.clear();
    if (!directory) return;
    // Resolve both paths before recursive removal; only this test's directory
    // beneath the project work directory may be removed, including on Windows.
    const safeRoot = realpathSync(testRoot);
    const target = realpathSync(resolve(directory));
    const descendant = relative(safeRoot, target);
    assert.ok(descendant && !isAbsolute(descendant)
      && descendant !== '..' && !descendant.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`),
    'Test cleanup target must remain beneath project/work/store-tests');
    rmSync(target, { recursive: true, force: true });
  });

  it('deduplicates a request within one conversation, even after completion', () => {
    const conversation = store.createConversation();
    const requestId = randomUUID();
    const original = store.enqueue(conversation.id, '请整理实验通知', requestId, 'medium');
    const duplicate = store.enqueue(conversation.id, '请整理实验通知', requestId, 'medium');
    assert.deepEqual(duplicate, original);
    assert.equal(store.snapshot(conversation.id).tasks.length, 1);
    assert.deepEqual(store.messages(conversation.id), [original.message]);
    assert.equal(store.events(original.task.id, 0).events.length, 1);

    assert.equal(store.claimNext()?.id, original.task.id);
    store.appendText(original.task.id, '已整理。');
    store.finish(original.task.id, 'completed');
    const before = store.snapshot(conversation.id);
    const eventsBefore = store.events(original.task.id, 0);
    const completedDuplicate = store.enqueue(conversation.id, '请整理实验通知', requestId, 'medium');
    assert.equal(completedDuplicate.task.id, original.task.id);
    assert.equal(completedDuplicate.task.status, 'completed');
    assert.deepEqual(completedDuplicate.message, original.message);
    assert.deepEqual(store.snapshot(conversation.id), before);
    assert.deepEqual(store.events(original.task.id, 0), eventsBefore);
  });

  it('rejects reuse of a request key with different text or effort without writes', () => {
    const conversation = store.createConversation();
    const requestId = randomUUID();
    const original = store.enqueue(conversation.id, '原始内容', requestId, 'low');
    const before = store.snapshot(conversation.id);
    const eventsBefore = store.events(original.task.id, 0);
    assert.throws(() => store.enqueue(conversation.id, '另一条内容', requestId, 'low'),
      domainError('idempotency_conflict', 409));
    assert.throws(() => store.enqueue(conversation.id, '原始内容', requestId, 'high'),
      domainError('idempotency_conflict', 409));
    assert.deepEqual(store.snapshot(conversation.id), before);
    assert.deepEqual(store.events(original.task.id, 0), eventsBefore);
    // A rejected transaction must not leave the connection inside a transaction.
    assert.equal(store.enqueue(conversation.id, '后续消息', randomUUID(), 'low').task.status, 'queued');
  });

  it('scopes request keys to their conversation', () => {
    const first = store.createConversation('第一段对话');
    const second = store.createConversation('第二段对话');
    const requestId = randomUUID();
    const a = store.enqueue(first.id, '第一条', requestId, 'low');
    const b = store.enqueue(second.id, '第二条', requestId, 'high');
    assert.notEqual(a.task.id, b.task.id);
    assert.deepEqual(store.messages(first.id), [a.message]);
    assert.deepEqual(store.messages(second.id), [b.message]);
  });

  it('claims queued tasks in insertion order and never claims one twice', () => {
    const conversation = store.createConversation();
    const tasks = Array.from({ length: 3 }, (_, index) =>
      store.enqueue(conversation.id, `任务 ${index}`, randomUUID(), 'medium').task);
    assert.deepEqual(tasks.map(() => store.claimNext()?.id), tasks.map(task => task.id));
    assert.equal(store.claimNext(), undefined);
    for (const task of tasks) {
      assert.equal(store.getTask(task.id).status, 'running');
      assert.equal(store.messages(conversation.id).filter(message =>
        message.taskId === task.id && message.role === 'assistant').length, 1);
    }
  });

  it('persists conversation metadata, thread ID, messages, tasks and events on reopen', () => {
    const conversation = store.createConversation('持久对话');
    store.setThreadId(conversation.id, 'external-thread-123');
    const { task } = store.enqueue(conversation.id, '原始问题', randomUUID(), 'high');
    store.claimNext();
    store.appendText(task.id, '第一段');
    store.appendText(task.id, '，第二段。');
    store.finish(task.id, 'completed');
    const before = store.snapshot(conversation.id);
    const eventsBefore = store.events(task.id, 0);
    reopen();
    assert.deepEqual(store.snapshot(conversation.id), before);
    assert.deepEqual(store.listConversations(), [before.conversation]);
    assert.equal(store.threadId(conversation.id), 'external-thread-123');
    assert.equal(store.taskText(task.id), '原始问题');
    assert.deepEqual(store.events(task.id, 0), eventsBefore);
    assert.equal(store.claimNext(), undefined);
  });

  it('keeps idempotency keys effective after SQLite is reopened', () => {
    const conversation = store.createConversation();
    const requestId = randomUUID();
    const original = store.enqueue(conversation.id, '跨重启发送', requestId, 'medium');
    reopen();
    assert.deepEqual(store.enqueue(conversation.id, '跨重启发送', requestId, 'medium'), original);
    assert.equal(store.snapshot(conversation.id).tasks.length, 1);
    assert.deepEqual(store.messages(conversation.id), [original.message]);
    assert.throws(() => store.enqueue(conversation.id, '内容被修改', requestId, 'medium'),
      domainError('idempotency_conflict', 409));
  });

  it('recovers running work as interrupted, keeps partial text, and waits for explicit retry', () => {
    const conversation = store.createConversation();
    const { task, message } = store.enqueue(conversation.id, '长任务', randomUUID(), 'high');
    store.claimNext();
    store.appendText(task.id, '尚未完成的回答');
    reopen();
    store.recoverInterrupted();
    assert.equal(store.getTask(task.id).status, 'interrupted');
    assert.ok(store.getTask(task.id).error);
    assert.deepEqual(store.messages(conversation.id).map(item => [item.role, item.text]),
      [['user', message.text], ['assistant', '尚未完成的回答']]);
    assert.equal(store.claimNext(), undefined);
    const recoveredEvents = store.events(task.id, 0);
    store.recoverInterrupted();
    assert.deepEqual(store.events(task.id, 0), recoveredEvents);
    store.appendText(task.id, '不应被追加的旧片段');
    store.finish(task.id, 'completed');
    assert.equal(store.getTask(task.id).status, 'interrupted');
    assert.deepEqual(store.events(task.id, 0), recoveredEvents);

    assert.equal(store.retry(task.id).status, 'queued');
    assert.equal(store.getTask(task.id).error, null);
    assert.equal(store.getTask(task.id).status, 'queued');
    assert.deepEqual(store.messages(conversation.id), [message]);
    assert.equal(store.claimNext()?.id, task.id);
    store.appendText(task.id, '重新执行的回答');
    store.finish(task.id, 'completed');
    assert.deepEqual(store.messages(conversation.id).map(item => [item.role, item.text]),
      [['user', message.text], ['assistant', '重新执行的回答']]);
  });

  it('restart recovery only interrupts running tasks', () => {
    const conversation = store.createConversation();
    const completed = store.enqueue(conversation.id, '已完成', randomUUID(), 'low').task;
    store.claimNext();
    store.finish(completed.id, 'completed');
    const running = store.enqueue(conversation.id, '正在执行', randomUUID(), 'low').task;
    store.claimNext();
    const queued = store.enqueue(conversation.id, '还在排队', randomUUID(), 'low').task;
    reopen();
    store.recoverInterrupted();
    assert.equal(store.getTask(completed.id).status, 'completed');
    assert.equal(store.getTask(running.id).status, 'interrupted');
    assert.equal(store.getTask(queued.id).status, 'queued');
    assert.equal(store.claimNext()?.id, queued.id);
    assert.equal(store.claimNext(), undefined);
  });

  it('cancellation wins over late deltas, completion and failure callbacks', () => {
    const conversation = store.createConversation();
    const { task } = store.enqueue(conversation.id, '即将取消', randomUUID(), 'medium');
    store.claimNext();
    store.appendText(task.id, '取消前已有内容');
    const cancelled = store.finish(task.id, 'cancelled');
    const before = store.snapshot(conversation.id);
    const eventsBefore = store.events(task.id, 0);
    store.appendText(task.id, '晚到的内容');
    assert.deepEqual(store.finish(task.id, 'completed'), cancelled);
    assert.deepEqual(store.finish(task.id, 'failed', '晚到的错误'), cancelled);
    assert.deepEqual(store.finish(task.id, 'cancelled'), cancelled);
    assert.deepEqual(store.snapshot(conversation.id), before);
    assert.deepEqual(store.events(task.id, 0), eventsBefore);
    assert.equal(store.claimNext(), undefined);
    reopen();
    assert.deepEqual(store.snapshot(conversation.id), before);
  });

  it('can cancel a queued task before an assistant message is created', () => {
    const conversation = store.createConversation();
    const { task, message } = store.enqueue(conversation.id, '排队任务', randomUUID(), 'low');
    store.finish(task.id, 'cancelled');
    assert.equal(store.claimNext(), undefined);
    assert.deepEqual(store.messages(conversation.id), [message]);
    assert.equal(store.finish(task.id, 'completed').status, 'cancelled');
  });

  it('explicitly retries a failed task without duplicating the user message', () => {
    const conversation = store.createConversation();
    const { task, message } = store.enqueue(conversation.id, '可重试任务', randomUUID(), 'medium');
    store.claimNext();
    store.appendText(task.id, '失败前的内容');
    store.finish(task.id, 'failed', '模型连接中断');
    assert.equal(store.getTask(task.id).error, '模型连接中断');
    const retry = store.retry(task.id);
    assert.equal(retry.id, task.id);
    assert.equal(retry.status, 'queued');
    assert.equal(retry.error, null);
    assert.deepEqual(store.messages(conversation.id), [message]);
    assert.equal(store.snapshot(conversation.id).tasks.length, 1);
    assert.equal(store.claimNext()?.id, task.id);
    store.appendText(task.id, '本次完整回答');
    store.finish(task.id, 'completed');
    assert.deepEqual(store.messages(conversation.id).map(item => [item.role, item.text]),
      [['user', message.text], ['assistant', '本次完整回答']]);
  });

  it('rejects retry for queued, running, completed and cancelled tasks', () => {
    const conversation = store.createConversation();
    const { task } = store.enqueue(conversation.id, '状态测试', randomUUID(), 'low');
    assert.throws(() => store.retry(task.id), domainError('invalid_state', 409));
    store.claimNext();
    assert.throws(() => store.retry(task.id), domainError('invalid_state', 409));
    store.finish(task.id, 'completed');
    assert.throws(() => store.retry(task.id), domainError('invalid_state', 409));
    const cancelled = store.enqueue(conversation.id, '已取消', randomUUID(), 'low').task;
    store.finish(cancelled.id, 'cancelled');
    assert.throws(() => store.retry(cancelled.id), domainError('invalid_state', 409));
  });

  it('replays task events in cursor order across page boundaries and a database reopen', () => {
    const conversation = store.createConversation();
    const first = store.enqueue(conversation.id, '第一项', randomUUID(), 'low').task;
    const other = store.enqueue(conversation.id, '另一项', randomUUID(), 'low').task;
    store.claimNext();
    store.claimNext();
    for (let index = 0; index < 205; index++) {
      store.appendText(first.id, String(index));
      if (index === 100) store.appendText(other.id, '别的任务事件');
    }
    store.finish(first.id, 'completed');
    const pageOne = store.events(first.id, 0);
    assert.equal(pageOne.events.length, 200);
    assert.equal(pageOne.nextCursor, pageOne.events.at(-1)?.id);
    reopen();
    const pageTwo = store.events(first.id, pageOne.nextCursor);
    const events = [...pageOne.events, ...pageTwo.events];
    assert.equal(events.length, 208); // queued, running, 205 deltas, completed
    assert.equal(new Set(events.map(event => event.id)).size, events.length);
    assert.ok(events.every(event => event.taskId === first.id));
    for (let index = 1; index < events.length; index++) {
      assert.ok(events[index]!.id > events[index - 1]!.id);
    }
    assert.deepEqual(events.filter(event => event.type === 'status').map(event => event.data),
      [{ status: 'queued' }, { status: 'running' }, { status: 'completed' }]);
    assert.deepEqual(events.filter(event => event.type === 'message_delta').map(event => event.data),
      Array.from({ length: 205 }, (_, index) => ({ text: String(index) })));
    assert.deepEqual(store.events(first.id, pageTwo.nextCursor),
      { events: [], nextCursor: pageTwo.nextCursor });
    assert.deepEqual(store.events(first.id, pageOne.nextCursor), pageTwo);
  });

  it('rejects a second database owner without disturbing live work and releases the lock on close', () => {
    const conversation = store.createConversation();
    const { task } = store.enqueue(conversation.id, '不能被其他实例恢复的任务', randomUUID(), 'low');
    store.claimNext();
    store.appendText(task.id, '仍由原实例执行');
    const before = store.snapshot(conversation.id);
    assert.throws(() => {
      const competing = new Store(databasePath);
      competing.close();
    }, /locked|busy/i);
    assert.deepEqual(store.snapshot(conversation.id), before);
    assert.equal(store.getTask(task.id).status, 'running');
    reopen();
    assert.deepEqual(store.snapshot(conversation.id), before);
    store.recoverInterrupted();
    assert.equal(store.getTask(task.id).status, 'interrupted');
  });

  it('returns explicit not-found errors and remains usable after a failed enqueue', () => {
    const missing = randomUUID();
    assert.throws(() => store.getConversation(missing), domainError('not_found', 404));
    assert.throws(() => store.getTask(missing), domainError('not_found', 404));
    assert.throws(() => store.events(missing, 0), domainError('not_found', 404));
    assert.throws(() => store.enqueue(missing, '不会保存', randomUUID(), 'low'),
      domainError('not_found', 404));
    const conversation = store.createConversation();
    assert.equal(store.enqueue(conversation.id, '有效任务', randomUUID(), 'low').task.status, 'queued');
  });
});