import type { AgentRuntime } from './runtime/types.js';
import { Store } from './store.js';

/** One active turn per service: a queued message never races the preceding turn. */
export class Worker {
  private busy = false;
  private stopped = false;
  private timer?: ReturnType<typeof setInterval>;
  private active?: { id: string; controller: AbortController; done: Promise<void> };
  constructor(private store: Store, private runtime: AgentRuntime, private shutdownTimeoutMs = 5000) {}
  start() {
    this.store.recoverInterrupted();
    this.timer = setInterval(() => this.wake(), 500);
    this.timer.unref();
    this.wake();
  }
  wake() {
    if (this.busy || this.stopped) return;
    const task = this.store.claimNext();
    if (!task) return;
    this.busy = true;
    const controller = new AbortController();
    let acceptsEvents = true;
    const done = (async () => {
      try {
        // An explicit task owns preparation/renewal. Read-only UI status must
        // not gate a resumable session whose access token merely needs refresh.
        await this.runtime.run({
          taskId: task.id, conversationId: task.conversationId,
          text: this.store.taskText(task.id), effort: task.effort,
          threadId: this.store.threadId(task.conversationId),
          history: this.store.historyBeforeTask(task.id),
        }, event => {
          if (!acceptsEvents || controller.signal.aborted) return;
          if (event.type === 'message_delta') this.store.appendText(task.id, event.data.text);
          else if (event.type === 'thread_started') this.store.setThreadId(task.conversationId, event.data.threadId);
          else this.store.appendEvent(task.id, event.type, event.data);
        }, controller.signal);
        if (!controller.signal.aborted) this.store.finish(task.id, 'completed');
      } catch (error) {
        if (!controller.signal.aborted) {
          const needsInput = error instanceof Error && ['RuntimeInputRequiredError', 'RuntimeUnavailableError'].includes(error.name);
          const interrupted = error instanceof Error && error.name === 'RuntimeInterruptedError';
          this.store.finish(task.id, needsInput ? 'waiting_for_input' : interrupted ? 'interrupted' : 'failed', error instanceof Error ? error.message : '执行失败，请检查服务连接。');
        }
      } finally {
        acceptsEvents = false;
        this.busy = false;
        this.active = undefined;
        if (!this.stopped) queueMicrotask(() => this.wake());
      }
    })();
    this.active = { id: task.id, controller, done };
  }
  cancel(id: string) {
    const task = this.store.cancel(id);
    if (this.active?.id === id) this.active.controller.abort();
    return task;
  }
  async close() {
    this.stopped = true;
    clearInterval(this.timer);
    const active = this.active;
    if (active) {
      this.store.finish(active.id, 'interrupted', '服务已停止，进度已保存。请核对后重试。');
      active.controller.abort();
    }
    // Some adapters fail to settle after abort. Bound shutdown and close the
    // runtime immediately so it can release the resource blocking run().
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled([active?.done, this.runtime.close()]),
      new Promise<void>(resolve => { timer = setTimeout(resolve, this.shutdownTimeoutMs); }),
    ]);
    clearTimeout(timer);
  }
}
