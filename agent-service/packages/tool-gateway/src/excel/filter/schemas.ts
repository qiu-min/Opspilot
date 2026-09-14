import { z } from 'zod';

import {
  excelPredicateLogicSchema,
  excelPredicateSchema,
} from '../shared/query/predicate-schemas.js';

const nonEmptyStringSchema = z.string().trim().min(1);

export const filterDataInputSchema = z.object({
  filePath: nonEmptyStringSchema,
  sheetName: nonEmptyStringSchema,
  range: nonEmptyStringSchema.optional(),
  conditions: z.array(excelPredicateSchema).min(1),
  logic: excelPredicateLogicSchema.default('all'),
});

export type FilterDataInputSchema = z.input<typeof filterDataInputSchema>;
