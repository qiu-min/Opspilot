import { z } from 'zod';

const text = (max: number) => z.string().trim().min(1).max(max);

export const modelApiSchema = text(100);
export type ModelApi = string;

export const thinkingLevelSchema = z.enum(['minimal', 'low', 'medium', 'high']);
export type ThinkingLevel = z.infer<typeof thinkingLevelSchema>;

export const modelThinkingLevelSchema = z.enum(['off', 'minimal', 'low', 'medium', 'high']);
export type ModelThinkingLevel = z.infer<typeof modelThinkingLevelSchema>;

export const thinkingLevelMapSchema = z
  .object({
    off: z.string().trim().min(1).max(100).nullable().optional(),
    minimal: z.string().trim().min(1).max(100).nullable().optional(),
    low: z.string().trim().min(1).max(100).nullable().optional(),
    medium: z.string().trim().min(1).max(100).nullable().optional(),
    high: z.string().trim().min(1).max(100).nullable().optional(),
  })
  .strict();
export type ThinkingLevelMap = z.infer<typeof thinkingLevelMapSchema>;

export const reasoningProtocolSchema = z.enum([
  'openai-reasoning-effort',
  'openai-reasoning-object',
  'deepseek-thinking',
]);
export type ReasoningProtocol = z.infer<typeof reasoningProtocolSchema>;

export const openAiCompletionsCompatSchema = z
  .object({
    maxTokensField: z.enum(['max_tokens', 'max_completion_tokens']).optional(),
    supportsTemperature: z.boolean().optional(),
    supportsToolChoice: z.boolean().optional(),
    requiresReasoningContentOnAssistantMessages: z.boolean().optional(),
    requiresAssistantContentForToolCalls: z.boolean().optional(),
  })
  .strict();
export interface OpenAiCompletionsCompat {
  readonly maxTokensField?: 'max_tokens' | 'max_completion_tokens';
  readonly supportsTemperature?: boolean;
  readonly supportsToolChoice?: boolean;
  readonly requiresReasoningContentOnAssistantMessages?: boolean;
  readonly requiresAssistantContentForToolCalls?: boolean;
}

export interface Model {
  readonly provider: string;
  readonly id: string;
  readonly name: string;
  readonly api: ModelApi;
  readonly baseUrl: string;
  readonly contextWindow?: number;
  readonly supportsTools?: boolean;
  readonly reasoning: boolean;
  readonly thinkingLevelMap?: ThinkingLevelMap;
  readonly reasoningProtocol?: ReasoningProtocol;
  readonly compat?: OpenAiCompletionsCompat;
}

export const modelSchema = z
  .object({
    provider: text(100),
    id: text(200),
    name: text(200),
    api: modelApiSchema,
    baseUrl: z
      .string()
      .url()
      .refine((value) => /^https?:\/\//u.test(value), 'baseUrl must use HTTP(S).'),
    contextWindow: z.number().int().positive().optional(),
    supportsTools: z.boolean().optional(),
    reasoning: z.boolean(),
    thinkingLevelMap: thinkingLevelMapSchema.optional(),
    reasoningProtocol: reasoningProtocolSchema.optional(),
    compat: openAiCompletionsCompatSchema.optional(),
  })
  .strict()
  .superRefine((model, context) => {
    if (model.reasoning && model.reasoningProtocol === undefined)
      context.addIssue({
        code: 'custom',
        path: ['reasoningProtocol'],
        message: 'reasoningProtocol is required when reasoning is enabled.',
      });
  });

export function validateModel(value: unknown): Model {
  const parsed = modelSchema.safeParse(value);
  if (!parsed.success) throw new Error('Invalid model.', { cause: parsed.error });
  return parsed.data;
}
