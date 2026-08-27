import { z } from 'zod';

const nonEmptyStringSchema = z.string().trim().min(1);

const aggregateMetricSchema = z.object({
  column: nonEmptyStringSchema,
  operation: z.enum(['sum', 'count', 'average', 'min', 'max']),
  alias: nonEmptyStringSchema.optional(),
});

export const aggregateDataInputSchema = z.object({
  filePath: nonEmptyStringSchema,
  sheetName: nonEmptyStringSchema,
  groupBy: z.array(nonEmptyStringSchema).default([]),
  metrics: z.array(aggregateMetricSchema).min(1),
});

export type AggregateDataInputSchema = z.input<typeof aggregateDataInputSchema>;
