import { isAbsolute, win32 } from 'node:path';

import { z } from 'zod';

const relativeStoragePathSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !isAbsolute(value) && !win32.isAbsolute(value), {
    message: 'storagePath must be relative to the shared storage root.',
  });

export const conversationTurnRequestSchema = z
  .object({
    sessionId: z.uuid({ version: 'v4' }).optional(),
    message: z.string().trim().min(1),
    excelResource: z
      .object({
        id: z.string().trim().min(1),
        storagePath: relativeStoragePathSchema,
      })
      .strict()
      .optional(),
  })
  .strict();

export type ExcelResourceRequest = NonNullable<
  z.infer<typeof conversationTurnRequestSchema>['excelResource']
>;
export type ConversationTurnRequest = z.infer<typeof conversationTurnRequestSchema>;
