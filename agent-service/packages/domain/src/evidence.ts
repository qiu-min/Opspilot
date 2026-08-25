import { z } from 'zod';

export const evidenceKindSchema = z.enum(['LOGS', 'METRICS', 'RUNBOOK', 'TOPOLOGY']);

export type EvidenceKind = z.infer<typeof evidenceKindSchema>;

export const evidenceSchema = z.object({
  id: z.uuid(),
  incidentId: z.uuid(),
  sourceRunId: z.uuid().nullable(),
  kind: evidenceKindSchema,
  summary: z.string().min(1),
  content: z.unknown(),
  contentHash: z.string().min(1),
  sourceUri: z.string().min(1).nullable(),
  timeRangeStart: z.string().datetime().nullable(),
  timeRangeEnd: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});

export type Evidence = z.infer<typeof evidenceSchema>;
