import { z } from 'zod';

export const OperationsStateSchema = z.enum(['ok', 'warning', 'error', 'unknown']);
const Timestamp = z.string().datetime();
const Status = z.object({
  state: OperationsStateSchema,
  code: z.string().max(80),
  message: z.string().max(300),
});

/** Sanitized operational metadata only: no paths, command output or credentials. */
export const OperationsStatusSchema = z.object({
  schemaVersion: z.literal(1),
  configured: z.boolean(),
  checkedAt: Timestamp,
  maintenance: z.object({
    active: z.boolean(),
    state: z.enum(['inactive', 'active', 'invalid', 'expired']),
    message: z.string().max(300),
    operationId: z.string().uuid().optional(),
    expiresAt: Timestamp.optional(),
  }),
  idle: z.object({ queued: z.number().int().nonnegative(), running: z.number().int().nonnegative(), workerBusy: z.boolean() }),
  health: Status.extend({
    checkedAt: Timestamp.nullable(),
    checks: z.array(z.object({
      name: z.enum(['api', 'tls', 'services', 'disk']),
      state: OperationsStateSchema,
      code: z.enum(['healthy', 'unavailable', 'expiring', 'expired', 'low_space', 'failed', 'unknown']),
      message: z.string().max(300),
    })).max(4),
    certificate: z.object({ expiresAt: Timestamp, remainingHours: z.number().finite() }).optional(),
  }),
  backup: Status.extend({
    lastAttemptAt: Timestamp.nullable(),
    lastSuccessAt: Timestamp.nullable(),
    archive: z.object({ createdAt: Timestamp, archiveBytes: z.number().int().nonnegative() }).optional(),
    retainedCount: z.number().int().nonnegative().optional(),
  }),
});
export type OperationsStatus = z.infer<typeof OperationsStatusSchema>;
