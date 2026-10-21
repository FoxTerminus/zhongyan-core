import { z } from 'zod';

const Uuid = z.string().uuid().transform(value => value.toLowerCase());
const Timestamp = z.string().datetime({ offset: true });
// Android/Java and JS queue truncation count UTF-16 code units. Zod string max
// can count Unicode code points, so enforce the wire/storage limit explicitly.
const boundedText = (maximum: number) => z.string().refine(value => value.length <= maximum, `不能超过 ${maximum} 个 UTF-16 单位。`);
export const NotificationEventSchema = z.object({
  eventId: Uuid,
  packageName: z.string().min(1).max(200).regex(/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/),
  appName: boundedText(100),
  title: boundedText(200),
  text: boundedText(2000),
  postedAt: Timestamp,
}).strict();
export const NotificationBatchSchema = z.object({
  deviceId: Uuid,
  events: z.array(NotificationEventSchema).min(1).max(20)
    .refine(events => new Set(events.map(event => event.eventId)).size === events.length, '同一批次不能重复事件标识。'),
}).strict();
export const NotificationBatchResultSchema = z.object({
  acceptedEventIds: z.array(Uuid).max(20), duplicateEventIds: z.array(Uuid).max(20), receivedAt: Timestamp,
}).strict();
export const NotificationQuerySchema = z.object({
  deviceId: Uuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
}).strict();
export const NotificationRecordSchema = NotificationEventSchema.extend({
  id: Uuid, deviceId: Uuid, receivedAt: Timestamp,
});
export const NotificationPageSchema = z.object({
  notifications: z.array(NotificationRecordSchema).max(100),
  nextCursor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
}).strict();
export const NotificationDeviceListSchema = z.object({
  devices: z.array(z.object({ deviceId: Uuid, count: z.number().int().positive(), lastReceivedAt: Timestamp }).strict()).max(100),
}).strict();
export const ClearNotificationsSchema = z.object({ deviceId: Uuid }).strict();
export const ClearNotificationsResultSchema = z.object({ deleted: z.number().int().nonnegative() }).strict();

export type NotificationEvent = z.infer<typeof NotificationEventSchema>;
export type NotificationBatch = z.infer<typeof NotificationBatchSchema>;
export type NotificationBatchResult = z.infer<typeof NotificationBatchResultSchema>;
export type NotificationQuery = z.infer<typeof NotificationQuerySchema>;
export type NotificationRecord = z.infer<typeof NotificationRecordSchema>;
export type NotificationPage = z.infer<typeof NotificationPageSchema>;
export type NotificationDeviceList = z.infer<typeof NotificationDeviceListSchema>;
export type ClearNotifications = z.infer<typeof ClearNotificationsSchema>;
export type ClearNotificationsResult = z.infer<typeof ClearNotificationsResultSchema>;
