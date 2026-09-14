import { z } from 'zod';

const nonEmptyStringSchema = z.string().trim().min(1);
const cellReferenceSchema = nonEmptyStringSchema;
const rangeSchema = z.string().optional();
const dataSchema = z.array(z.array(z.unknown()).min(1)).min(1);

export const readRangeInputSchema = z.object({
  filePath: nonEmptyStringSchema,
  sheetName: nonEmptyStringSchema,
  range: rangeSchema,
});

export const writeDataInputSchema = z.object({
  filePath: nonEmptyStringSchema,
  sheetName: nonEmptyStringSchema.optional(),
  data: dataSchema,
  startCell: cellReferenceSchema.default('A1'),
});

export const readRangeWithMetadataInputSchema = z.object({
  filePath: nonEmptyStringSchema,
  sheetName: nonEmptyStringSchema,
  range: rangeSchema,
  includeValidation: z.boolean().default(true),
});

export type ReadRangeInputSchema = z.input<typeof readRangeInputSchema>;
export type WriteDataInputSchema = z.input<typeof writeDataInputSchema>;
export type ReadRangeWithMetadataInputSchema = z.input<typeof readRangeWithMetadataInputSchema>;
