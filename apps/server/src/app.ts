import Fastify from 'fastify';
import { createHash, timingSafeEqual } from 'node:crypto';
import { z, ZodError } from 'zod';
import { CreateConversationSchema, SendMessageSchema, KnowledgeInputSchema, ReviseKnowledgeSchema, PROTOCOL_VERSION } from '@personal-agent/contracts';
import { DomainError } from './errors.js';
import { Store } from './store.js';
import { KnowledgeStore } from './knowledge.js';
import type { AgentRuntime } from './runtime/types.js';
import { Worker } from './worker.js';
import { OperationsReader } from './operations.js';

interface AppOptions {
  store: Store;
  knowledge?: KnowledgeStore;
  runtime: AgentRuntime;
  authToken: string;
  startWorker?: boolean;
  allowedOrigins?: string[];
  operationsDir?: string;
}
const IdParams = z.object({ id: z.uuid() });
const CursorQuery = z.object({ after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0) });
export function createApp(options: AppOptions) {
  if (options.authToken.length < 32) throw new Error('服务连接密钥至少需要 32 个字符。');
  const { store, runtime } = options;
  const worker = new Worker(store, runtime);
  const operations = new OperationsReader(options.operationsDir);
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024, requestTimeout: 15000 });
  const expected = createHash('sha256').update(options.authToken).digest();
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
    const origin = request.headers.origin;
    if (origin && options.allowedOrigins?.includes(origin)) {
      reply.header('Access-Control-Allow-Origin', origin).header('Vary', 'Origin')
        .header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
        .header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
    if (request.method === 'OPTIONS') { reply.code(204).send(); return; }
    if (request.url.split('?')[0] === '/health') return;
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ') || header.length > 2048 || !timingSafeEqual(expected, createHash('sha256').update(header.slice(7)).digest())) {
      reply.code(401).send({ error: { code: 'unauthorized', message: '连接密钥无效，请检查连接设置。' } });
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: { code: 'invalid_input', message: '输入格式不正确，请检查后再试。' } });
    if (error instanceof DomainError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
    if (error && typeof error === 'object' && 'statusCode' in error && error.statusCode === 400) return reply.code(400).send({ error: { code: 'invalid_input', message: '请求格式不正确，请检查后再试。' } });
    if (error && typeof error === 'object' && 'statusCode' in error && error.statusCode === 413) return reply.code(413).send({ error: { code: 'too_large', message: '消息太长，请分段发送。' } });
    return reply.code(500).send({ error: { code: 'internal_error', message: '服务暂时无法完成操作，请稍后重试。' } });
  });
  app.get('/health', async () => ({ status: 'ok', protocolVersion: PROTOCOL_VERSION }));
  app.get('/v1/status', async () => ({ runtime: await runtime.getStatus(), protocolVersion: PROTOCOL_VERSION }));
  app.get('/v1/operations', async request => {
    // Reject filename/path-like query input rather than accidentally extending
    // this endpoint into a file reader. The host publishes only fixed files.
    z.object({}).strict().parse(request.query);
    return operations.snapshot({ ...store.taskCounts(), workerBusy: worker.isBusy() });
  });
  const knowledge = () => {
    if (!options.knowledge) throw new DomainError('unavailable', '资料库尚未启用。', 503);
    return options.knowledge;
  };
  app.get('/v1/knowledge', async () => ({ notes: knowledge().list() }));
  app.post('/v1/knowledge', async (request, reply) => reply.code(201).send({ note: knowledge().create(KnowledgeInputSchema.parse(request.body)) }));
  app.get('/v1/knowledge/search', async request => {
    const query = z.object({ q: z.string().max(2000).default(''), limit: z.coerce.number().int().min(1).max(100).default(10) }).parse(request.query);
    return { hits: knowledge().search(query.q, query.limit) };
  });
  app.get('/v1/knowledge/:id', async request => ({ note: knowledge().get(IdParams.parse(request.params).id) }));
  app.get('/v1/knowledge/:id/revisions', async request => ({ revisions: knowledge().listRevisions(IdParams.parse(request.params).id) }));
  app.post('/v1/knowledge/:id/revisions', async request => ({ note: knowledge().revise(IdParams.parse(request.params).id, ReviseKnowledgeSchema.parse(request.body)) }));
  app.get('/v1/conversations', async () => ({ conversations: store.listConversations() }));
  app.post('/v1/conversations', async request => ({ conversation: store.createConversation(CreateConversationSchema.parse(request.body ?? {}).title) }));
  app.get('/v1/conversations/:id', async request => store.snapshot(IdParams.parse(request.params).id));
  app.post('/v1/conversations/:id/messages', async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const input = SendMessageSchema.parse(request.body);
    operations.assertAcceptingTasks();
    const result = store.enqueue(id, input.text, input.clientRequestId, input.effort);
    if (options.startWorker !== false) worker.wake();
    return reply.code(202).send(result);
  });
  app.post('/v1/tasks/:id/cancel', async request => ({ task: worker.cancel(IdParams.parse(request.params).id) }));
  app.post('/v1/tasks/:id/retry', async request => {
    operations.assertAcceptingTasks();
    const task = store.retry(IdParams.parse(request.params).id);
    if (options.startWorker !== false) worker.wake();
    return { task };
  });
  app.get('/v1/tasks/:id/events', async request => store.events(IdParams.parse(request.params).id, CursorQuery.parse(request.query).after));
  app.addHook('onReady', async () => { if (options.startWorker !== false) worker.start(); });
  app.addHook('onClose', async () => { await worker.close(); store.close(); options.knowledge?.close(); });
  return app;
}
