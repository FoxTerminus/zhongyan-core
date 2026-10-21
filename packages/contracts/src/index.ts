import { z } from 'zod';
export { OperationsStatusSchema, OperationsStateSchema, type OperationsStatus } from './operations.js';

export const PROTOCOL_VERSION = 1 as const;
export const EffortSchema = z.enum(['low', 'medium', 'high']);
export type Effort = z.infer<typeof EffortSchema>;
export const TaskStatusSchema = z.enum(['queued', 'running', 'waiting_for_input', 'completed', 'failed', 'cancelled', 'interrupted']);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export const CreateConversationSchema = z.object({ title: z.string().trim().min(1).max(100).optional() }).strict();
export const SendMessageSchema = z.object({ text: z.string().trim().min(1).max(32000), clientRequestId: z.string().uuid(), effort: EffortSchema.default('medium') }).strict();
export interface Conversation { id: string; title: string; createdAt: string; updatedAt: string }
export interface Message { id: string; conversationId: string; role: 'user' | 'assistant' | 'system'; text: string; createdAt: string; taskId: string | null }
export interface Task { id: string; conversationId: string; status: TaskStatus; effort: Effort; createdAt: string; updatedAt: string; error: string | null }
export interface TaskEvent { id: number; taskId: string; type: string; data: unknown; createdAt: string }
export interface RuntimeStatus { provider: string; available: boolean; authenticated: boolean | null; message: string; models: Array<{ id: string; displayName: string }> }
export interface ConversationSnapshot { conversation: Conversation; messages: Message[]; tasks: Task[] }
export interface ApiError { error: { code: string; message: string } }


export const KnowledgeInputSchema = z.object({
  title: z.string().trim().min(1).max(100),
  body: z.string().min(1).max(32000),
  source: z.string().max(2000).nullable().optional(),
}).strict();
export const ReviseKnowledgeSchema = KnowledgeInputSchema.extend({ expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) });
export type KnowledgeInput = z.infer<typeof KnowledgeInputSchema>;
export interface KnowledgeNote {
  id: string; title: string; body: string; source: string | null;
  revision: number; createdAt: string; updatedAt: string;
}
export interface KnowledgeSearchHit {
  id: string; title: string; source: string | null; revision: number;
  snippet: string; matchedField: 'title' | 'body' | 'source'; start: number; end: number;
}
