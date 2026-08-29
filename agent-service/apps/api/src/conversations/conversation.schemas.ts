import { z } from 'zod';

export const conversationTurnRequestSchema = z
  .object({
    sessionId: z.string().optional(),
    message: z.string().trim().min(1),
  })
  .strict();

export type ConversationTurnRequest = z.infer<typeof conversationTurnRequestSchema>;
