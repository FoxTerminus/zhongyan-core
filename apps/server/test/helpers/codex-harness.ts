import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { CodexRuntime, type CodexRuntimeOptions } from '../../src/runtime/codex.js';
import type { RuntimeInput } from '../../src/runtime/types.js';

export type Rpc = Record<string, any>;
export type Handler = (request: Rpc, reply: (response: Rpc) => void) => boolean | void;
export const input: RuntimeInput = {
  taskId: 'task', conversationId: 'conversation', text: '你好',
  effort: 'medium', threadId: null,
};

export function harness(handler: Handler = () => false, options: Partial<CodexRuntimeOptions> = {}) {
  const launches: { command: string; args: string[]; cwd: string }[] = [];
  const requests: Rpc[] = [];
  const stdout = new PassThrough();
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  let killed = false;
  const reply = (message: Rpc) => queueMicrotask(() => stdout.write(`${JSON.stringify(message)}\n`));
  const replyBatch = (messages: Rpc[]) => queueMicrotask(() => stdout.write(messages.map(message => JSON.stringify(message)).join('\n') + '\n'));
  const stdin = new Writable({
    write(chunk, _encoding, done) {
      const request = JSON.parse(chunk.toString()) as Rpc;
      requests.push(request);
      if (!handler(request, reply)) {
        const result: Record<string, unknown> = {
          initialize: { userAgent: 'fixture' },
          'account/read': { account: { type: 'chatgpt', email: 'private@example.invalid', planType: 'pro' } },
          'model/list': { data: [{ id: 'dynamic-id', model: 'available-model', displayName: 'Available model' }], nextCursor: null },
          'config/read': { config: { mcp_servers: {} } },
          'thread/start': { thread: { id: 'thread' } },
          'thread/resume': { thread: { id: 'thread' } },
          'turn/start': { turn: { id: 'turn', status: 'inProgress' } },
          'turn/interrupt': {},
        };
        if (request.id !== undefined && request.method) reply({ id: request.id, result: result[request.method] ?? {} });
      }
      done();
    },
  });
  Object.assign(child, {
    stdin, stdout, stderr: new PassThrough(),
    kill() { killed = true; queueMicrotask(() => child.emit('exit', null, 'SIGTERM')); return true; },
  });
  const runtime = new CodexRuntime({ cwd: process.cwd(), requestTimeoutMs: 100, ...options }, (command, args, cwd) => {
    launches.push({ command, args, cwd });
    return child;
  });
  return { runtime, requests, reply, replyBatch, child, launches, get killed() { return killed; } };
}

export const delta = (text: string, threadId = 'thread') => ({
  method: 'item/agentMessage/delta', params: { threadId, turnId: 'turn', itemId: 'answer', delta: text },
});
export const completed = (status = 'completed') => ({
  method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status } },
});
