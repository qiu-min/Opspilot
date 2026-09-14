import { z } from 'zod';

import {
  excelPredicateLogicSchema,
  excelPredicateSchema,
} from '../shared/query/predicate-schemas.js';

const nonEmptyStringSchema = z.string().trim().min(1);

const aggregateMetricSchema = z.object({
  column: nonEmptyStringSchema,
  operation: z.enum(['sum', 'count', 'average', 'min', 'max']),
  alias: nonEmptyStringSchema.optional(),
});

export const aggregateDataInputSchema = z.object({
  filePath: nonEmptyStringSchema,
  sheetName: nonEmptyStringSchema,
  range: nonEmptyStringSchema.optional(),
  where: z
    .object({
      conditions: z.array(excelPredicateSchema).min(1),
      logic: excelPredicateLogicSchema.default('all'),
    })
    .optional(),
  groupBy: z.array(nonEmptyStringSchema).default([]),
  metrics: z.array(aggregateMetricSchema).min(1),
});

export type AggregateDataInputSchema = z.input<typeof aggregateDataInputSchema>;
