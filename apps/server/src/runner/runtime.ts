import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { FilePlanProfileStore } from '../auth/profile-store.js';
import { StoredPlanCredentialProvider } from '../auth/provider.js';
import { CodexRuntime } from '../runtime/codex.js';
import type { AgentRuntime, RuntimeEvent, RuntimeInput } from '../runtime/types.js';
import type { RunnerConfig } from './config.js';

function groupExists(pid: number): boolean {
  try { process.kill(-pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
}
async function waitForGroup(pid: number, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  do {
    if (!groupExists(pid)) return true;
    await delay(25);
  } while (Date.now() < until);
  return !groupExists(pid);
}
async function stopGroup(pid: number): Promise<void> {
  signalGroup(pid, 'SIGTERM');
  if (await waitForGroup(pid, 2000)) return;
  signalGroup(pid, 'SIGKILL');
  if (!await waitForGroup(pid, 2000)) throw new Error('执行器子进程组未能停止。');
}

/** Linux runner owns the entire app-server process group, including cleanup. */
export class ManagedPlanRuntime implements AgentRuntime {
  private readonly inner: CodexRuntime;
  private readonly groups = new Map<number, Promise<void> | null>();
  private cleanupFailure = false;
  constructor(config: RunnerConfig) {
    if (process.platform !== 'linux') throw new Error('私有执行器进程管理仅支持 Linux 容器。');
    const launch = (command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams => {
      const child = spawn(command, args, { cwd, env, detached: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      const pid = child.pid;
      if (pid) {
        this.groups.set(pid, null);
        // CodexRuntime terminates its direct child on cancellation or protocol
        // failure. Extend that operation to its isolated process group.
        child.kill = () => { void this.stop(pid).catch(() => {}); return true; };
        child.once('exit', () => { void this.stop(pid).catch(() => {}); });
        child.once('error', () => { void this.stop(pid).catch(() => {}); });
      }
      return child;
    };
    this.inner = new CodexRuntime({
      command: config.command, cwd: config.workspace, model: config.model,
      knowledgeTools: 'disabled', appTitle: config.appTitle,
      planCredentials: new StoredPlanCredentialProvider(new FilePlanProfileStore(config.profileDir)),
    }, launch);
  }
  private stop(pid: number): Promise<void> {
    if (!this.groups.has(pid)) return Promise.resolve();
    const existing = this.groups.get(pid);
    if (existing) return existing;
    const stopping = stopGroup(pid).catch(error => { this.cleanupFailure = true; throw error; })
      .finally(() => { this.groups.delete(pid); });
    this.groups.set(pid, stopping);
    return stopping;
  }
  getStatus() { return this.inner.getStatus(); }
  run(input: RuntimeInput, sink: (event: RuntimeEvent) => void, signal: AbortSignal) {
    if (this.cleanupFailure || [...this.groups.values()].some(Boolean)) return Promise.reject(new Error('执行器正在清理前一进程。'));
    return this.inner.run(input, sink, signal);
  }
  async close(): Promise<void> {
    await this.inner.close();
    await Promise.all([...this.groups.keys()].map(pid => this.stop(pid)));
    if (this.cleanupFailure) throw new Error('执行器子进程清理失败，需要重启执行器。');
  }
}
