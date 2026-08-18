import { z } from 'zod';
import type { ModelThinkingLevel, ThinkingLevel } from './model.js';

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export const usageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
  })
  .strict();

export const finishReasonSchema = z.enum(['stop', 'tool_calls', 'length', 'refusal']);
export type FinishReason = z.infer<typeof finishReasonSchema>;

export interface ReasoningDecision {
  readonly requested: ThinkingLevel;
  readonly selected: ModelThinkingLevel;
}

