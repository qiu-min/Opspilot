import { z } from 'zod';

export const runEventTypeSchema = z.enum([
  'alert.received',
  'run.started',
  'model.response.delta',
  'model.response.completed',
  'tool.requested',
  'tool.started',
  'tool.progressed',
  'tool.completed',
  'action.proposed',
  'approval.requested',
  'approval.decided',
  'execution.started',
  'execution.completed',
  'run.completed',
  'run.failed',
]);

export type RunEventType = z.infer<typeof runEventTypeSchema>;

export const runEventSchema = z.object({
  id: z.uuid(),
  incidentId: z.uuid(),
  runId: z.uuid(),
  parentEventId: z.uuid().nullable(),
  type: runEventTypeSchema,
  payload: z.record(z.string(), z.unknown()),
  schemaVersion: z.number().int().positive(),
  createdAt: z.string().datetime(),
});

export type RunEvent = z.infer<typeof runEventSchema>;
