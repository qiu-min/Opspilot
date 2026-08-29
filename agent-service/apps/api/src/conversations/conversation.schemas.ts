import { z } from 'zod';

export const conversationTurnRequestSchema = z
  .object({
    sessionId: z.uuid({ version: 'v4' }).optional(),
    message: z.string().trim().min(1),
  })
  .strict();

export type ConversationTurnRequest = z.infer<typeof conversationTurnRequestSchema>;
