import {
  analysisRunStatusSchema,
  incidentDtoSchema,
  incidentStatusSchema,
  runEventSchema,
} from '@opspilot/domain';
import { z } from 'zod';

export const alertSeveritySchema = z.enum(['critical', 'high', 'medium', 'low']);

const nonEmptyText = (maximum: number) => z.string().trim().min(1).max(maximum);

export const alertLabelsSchema = z
  .record(z.string().trim().min(1).max(64), z.string().max(256))
  .refine((labels) => Object.keys(labels).length <= 20, {
    message: 'labels must contain at most 20 entries.',
  });

export const createAlertRequestSchema = z
  .object({
    title: nonEmptyText(200),
    source: nonEmptyText(100),
    severity: alertSeveritySchema,
    triggeredAt: z.string().datetime({ offset: true }),
    service: nonEmptyText(100),
    summary: nonEmptyText(2_000),
    labels: alertLabelsSchema.optional(),
    sourceReference: z.url().max(2_048).optional(),
  })
  .strict();

export type CreateAlertRequest = z.infer<typeof createAlertRequestSchema>;

/**
 * The sanitized alert fields an Agent may receive when investigating an incident.
 * This is an input DTO, not a projection of the persisted Incident entity.
 */
export const incidentSnapshotSchema = createAlertRequestSchema
  .pick({
    title: true,
    severity: true,
    triggeredAt: true,
    service: true,
    summary: true,
  })
  .extend({ incidentId: z.uuid() })
  .strict();

export type IncidentSnapshot = z.infer<typeof incidentSnapshotSchema>;

export const createAlertResponseSchema = z.object({
  incidentId: z.uuid(),
  runId: z.uuid(),
  incidentStatus: incidentStatusSchema,
  runStatus: analysisRunStatusSchema,
  createdAt: z.string().datetime(),
  requestId: z.uuid(),
});

export type CreateAlertResponse = z.infer<typeof createAlertResponseSchema>;

export const incidentRunSummarySchema = z.object({
  id: z.uuid(),
  incidentId: z.uuid(),
  status: analysisRunStatusSchema,
  createdAt: z.string().datetime(),
});

export const getIncidentDetailResponseSchema = z.object({
  incident: incidentDtoSchema,
  runs: z.array(incidentRunSummarySchema),
  timeline: z.array(runEventSchema),
});

export type GetIncidentDetailResponse = z.infer<typeof getIncidentDetailResponseSchema>;
