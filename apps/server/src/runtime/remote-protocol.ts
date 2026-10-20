import { z } from 'zod';

export const RUNNER_PROTOCOL = 1;
export const MAX_RUNNER_FRAME_BYTES = 64 * 1024;
export const MAX_RUNNER_REQUEST_BYTES = 256 * 1024;
export const DEFAULT_RUNNER_OUTPUT_BYTES = 2 * 1024 * 1024;
export const DEFAULT_RUNNER_TURN_MS = 10 * 60 * 1000;
const id = z.string().min(1).max(256);
export const RunnerInput = z.object({
  taskId: id, conversationId: id, text: z.string().min(1).max(32_000),
  effort: z.enum(['low', 'medium', 'high']), threadId: id.nullable(),
}).strict();
export const RunnerRequest = z.object({
  protocolVersion: z.literal(RUNNER_PROTOCOL), runId: z.uuid(), input: RunnerInput,
}).strict();
export const RunnerEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message_delta'), data: z.object({ text: z.string().max(16_000) }).strict() }).strict(),
  z.object({ type: z.literal('activity'), data: z.object({ message: z.string().max(2048) }).strict() }).strict(),
  z.object({ type: z.literal('thread_started'), data: z.object({ threadId: id }).strict() }).strict(),
  z.object({ type: z.literal('approval_required'), data: z.object({ message: z.string().max(2048) }).strict() }).strict(),
]);
export const RunnerStatus = z.object({
  provider: z.string().min(1).max(100), available: z.boolean(), authenticated: z.boolean().nullable(),
  message: z.string().max(2048),
  models: z.array(z.object({ id, displayName: z.string().max(256) }).strict()).max(1000),
}).strict();
export const RunnerFrame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('accepted'), runId: z.uuid(), seq: z.literal(0) }).strict(),
  z.object({ type: z.literal('event'), runId: z.uuid(), seq: z.number().int().positive(), event: RunnerEvent }).strict(),
  z.object({
    type: z.literal('terminal'), runId: z.uuid(), seq: z.number().int().positive(),
    status: z.enum(['completed', 'interrupted', 'failed', 'waiting_for_input']),
    message: z.string().max(2048).optional(),
  }).strict(),
]);
export type RunnerFrameValue = z.infer<typeof RunnerFrame>;

/** Incremental byte parser; split UTF-8 characters and newline boundaries are supported. */
export class RunnerFrameDecoder {
  private pending = Buffer.alloc(0);
  private total = 0;
  constructor(private maxBytes = DEFAULT_RUNNER_OUTPUT_BYTES) {}
  push(chunk: Uint8Array): RunnerFrameValue[] {
    this.total += chunk.byteLength;
    if (this.total > this.maxBytes) throw new Error('Runner output limit exceeded.');
    this.pending = Buffer.concat([this.pending, chunk]);
    const frames: RunnerFrameValue[] = [];
    for (;;) {
      const newline = this.pending.indexOf(10);
      if (newline < 0) break;
      if (newline > MAX_RUNNER_FRAME_BYTES || newline === 0) throw new Error('Invalid runner frame.');
      const line = this.pending.subarray(0, newline);
      this.pending = this.pending.subarray(newline + 1);
      frames.push(RunnerFrame.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line))));
    }
    if (this.pending.length > MAX_RUNNER_FRAME_BYTES) throw new Error('Runner frame limit exceeded.');
    return frames;
  }
  finish(): void { if (this.pending.length) throw new Error('Truncated runner frame.'); }
}
