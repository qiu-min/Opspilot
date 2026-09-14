import { z } from 'zod';

const nonEmptyStringSchema = z.string().trim().min(1);
const valueOperators = new Set(['equals', 'notEquals', 'greaterThan', 'lessThan', 'contains']);

/** Runtime schema for the shared Excel predicate contract. */
export const excelPredicateSchema = z
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
    value: z.union([z.string(), z.number(), z.boolean(), z.date()]).optional(),
  })
  .superRefine((predicate, context) => {
    if (valueOperators.has(predicate.operator) && predicate.value === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['value'],
        message: `Operator '${predicate.operator}' requires a value`,
      });
    }

    if (!valueOperators.has(predicate.operator) && predicate.value !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['value'],
        message: `Operator '${predicate.operator}' does not accept a value`,
      });
    }
  });

export const excelPredicateLogicSchema = z.enum(['all', 'any']);
