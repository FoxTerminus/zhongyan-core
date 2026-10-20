import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { Store } from '../src/store.js';
import { Worker } from '../src/worker.js';
import type { AgentRuntime, RuntimeEvent, RuntimeInput } from '../src/runtime/types.js';

const testRoot = fileURLToPath(new URL('../../../work/worker-tests/', import.meta.url));
const nextLoop = () => new Promise<void>(resolve => setImmediate(resolve));

class UncooperativeRuntime implements AgentRuntime {
  sink?: (event: RuntimeEvent) => void;
  signal?: AbortSignal;
  calls = 0;
  closeCalled = false;
  resolveRun!: () => void;
  rejectRun!: (error: Error) => void;
  resolveClose!: () => void;
  private runDone = new Promise<void>((resolve, reject) => { this.resolveRun = resolve; this.rejectRun = reject; });
  private closeDone = new Promise<void>(resolve => { this.resolveClose = resolve; });

  async getStatus() {
    return { provider: 'test-only', available: true, authenticated: true, message: '', models: [] };
  }
  async run(_input: RuntimeInput, sink: (event: RuntimeEvent) => void, signal: AbortSignal) {
    this.calls++;
    this.sink = sink;
    this.signal = signal;
    // Deliberately do not settle on abort: exercise the worker's shutdown bound.
    await this.runDone;
  }
  async close() { this.closeCalled = true; await this.closeDone; }
  release() { this.resolveRun(); this.resolveClose(); }
}

for (const outcome of ['resolve', 'reject'] as const) {
  it(`bounds shutdown of a hung adapter and ignores late ${outcome} and events after database close`, { timeout: 3000 }, async () => {
    mkdirSync(testRoot, { recursive: true });
    const directory = mkdtempSync(join(testRoot, 'worker-'));
    const databasePath = join(directory, 'state.sqlite');
    const store = new Store(databasePath);
    const runtime = new UncooperativeRuntime();
    const worker = new Worker(store, runtime, 50);
    let storeClosed = false;
    try {
      const conversation = store.createConversation();
      const first = store.enqueue(conversation.id, '关闭前的任务', randomUUID(), 'low').task;
      const queued = store.enqueue(conversation.id, '仍在排队', randomUUID(), 'low').task;
      worker.start();
      const deadline = Date.now() + 1000;
      while (!runtime.sink) {
        assert.ok(Date.now() < deadline, 'The fake runtime must start');
        await nextLoop();
      }
      runtime.sink({ type: 'message_delta', data: { text: '保留已完成部分' } });
      const beforeClose = performance.now();
      await worker.close();
      const elapsed = performance.now() - beforeClose;
      assert.ok(elapsed >= 25 && elapsed < 1500, `Shutdown should honor its short deadline, took ${elapsed} ms`);
      assert.equal(runtime.closeCalled, true);
      assert.equal(runtime.signal?.aborted, true);
      assert.equal(store.getTask(first.id).status, 'interrupted');
      assert.equal(store.getTask(queued.id).status, 'queued');
      const snapshot = store.snapshot(conversation.id);
      const events = store.events(first.id, 0);
      store.close();
      storeClosed = true;
      assert.doesNotThrow(() => {
        runtime.sink!({ type: 'message_delta', data: { text: '不得写入关闭数据库' } });
        runtime.sink!({ type: 'thread_started', data: { threadId: 'late-thread' } });
        runtime.sink!({ type: 'activity', data: { message: '过期活动' } });
      });
      if (outcome === 'resolve') runtime.resolveRun();
      else runtime.rejectRun(new Error('停止后到达的失败'));
      await nextLoop();
      await nextLoop();
      assert.equal(runtime.calls, 1);
      const reopened = new Store(databasePath);
      try {
        assert.deepEqual(reopened.snapshot(conversation.id), snapshot);
        assert.deepEqual(reopened.events(first.id, 0), events);
        assert.equal(reopened.threadId(conversation.id), null);
      } finally { reopened.close(); }
    } finally {
      runtime.release();
      await worker.close();
      if (!storeClosed) store.close();
      const root = realpathSync(testRoot);
      const target = realpathSync(directory);
      const child = relative(root, target);
      assert.ok(child && !isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`),
        'Cleanup must remain within project/work/worker-tests');
      rmSync(target, { recursive: true, force: true });
    }
  });
}