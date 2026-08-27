import { z } from 'zod';

const nonEmptyStringSchema = z.string().trim().min(1);
const cellReferenceSchema = nonEmptyStringSchema;
const startCellSchema = cellReferenceSchema.default('A1');
const dataSchema = z.array(z.array(z.unknown()).min(1)).min(1);

export const readRangeInputSchema = z.object({
  filePath: nonEmptyStringSchema,
  sheetName: nonEmptyStringSchema,
  startCell: startCellSchema,
  endCell: cellReferenceSchema.optional(),
});

export const writeDataInputSchema = z.object({
  filePath: nonEmptyStringSchema,
  sheetName: nonEmptyStringSchema.optional(),
  data: dataSchema,
  startCell: startCellSchema,
});

export const readRangeWithMetadataInputSchema = z.object({
  filePath: nonEmptyStringSchema,
  sheetName: nonEmptyStringSchema,
  startCell: startCellSchema,
  endCell: cellReferenceSchema.optional(),
  includeValidation: z.boolean().default(true),
});

export type ReadRangeInputSchema = z.input<typeof readRangeInputSchema>;
export type WriteDataInputSchema = z.input<typeof writeDataInputSchema>;
export type ReadRangeWithMetadataInputSchema = z.input<typeof readRangeWithMetadataInputSchema>;
