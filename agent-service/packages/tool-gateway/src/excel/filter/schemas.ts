import { z } from 'zod';

const nonEmptyStringSchema = z.string().trim().min(1);
const filterValueSchema = z.union([z.string(), z.number(), z.boolean(), z.date()]);
const valueOperators = new Set(['equals', 'notEquals', 'greaterThan', 'lessThan', 'contains']);

const filterConditionSchema = z
  .object({
    column: nonEmptyStringSchema,
    operator: z.enum([
      'equals',
      'notEquals',
      'greaterThan',
      'lessThan',
      'contains',
      'isEmpty',
      'isNotEmpty',
    ]),
    value: filterValueSchema.optional(),
  })
  .superRefine((condition, context) => {
    if (valueOperators.has(condition.operator) && condition.value === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['value'],
        message: `Operator '${condition.operator}' requires a value`,
      });
    }

    if (!valueOperators.has(condition.operator) && condition.value !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['value'],
        message: `Operator '${condition.operator}' does not accept a value`,
      });
    }
  });

export const filterDataInputSchema = z.object({
  filePath: nonEmptyStringSchema,
  sheetName: nonEmptyStringSchema,
  conditions: z.array(filterConditionSchema).min(1),
  logic: z.enum(['all', 'any']).default('all'),
});

export type FilterDataInputSchema = z.input<typeof filterDataInputSchema>;
