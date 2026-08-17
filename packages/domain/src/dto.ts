import { z } from 'zod';

import { actionStatusSchema } from './action.js';
import { analysisRunStatusSchema } from './analysis-run.js';
import { incidentStatusSchema } from './incident.js';

export const incidentDtoSchema = z.object({
  id: z.uuid(),
  status: incidentStatusSchema,
  createdAt: z.string().datetime(),
});

export type IncidentDto = z.infer<typeof incidentDtoSchema>;

export const analysisRunDtoSchema = z.object({
  id: z.uuid(),
  incidentId: z.uuid(),
  status: analysisRunStatusSchema,
  createdAt: z.string().datetime(),
});

export type AnalysisRunDto = z.infer<typeof analysisRunDtoSchema>;

export const actionDtoSchema = z.object({
  id: z.uuid(),
  incidentId: z.uuid(),
  runId: z.uuid(),
  status: actionStatusSchema,
});

export type ActionDto = z.infer<typeof actionDtoSchema>;
