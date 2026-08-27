import { z } from 'zod';

const nonEmptyStringSchema = z.string().trim().min(1);

export const getWorkbookInfoInputSchema = z.object({
  filePath: nonEmptyStringSchema,
});

export const getSheetProfileInputSchema = z.object({
  filePath: nonEmptyStringSchema,
  sheetName: nonEmptyStringSchema,
  sampleSize: z.number().int().min(1).max(200).default(50),
});

export type GetWorkbookInfoInputSchema = z.input<typeof getWorkbookInfoInputSchema>;
export type GetSheetProfileInputSchema = z.input<typeof getSheetProfileInputSchema>;
