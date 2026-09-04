import type { Model } from '../contracts/model.js';

/** OpenAI Chat Completions compatibility settings after applying protocol defaults. */
export interface ResolvedOpenAiCompletionsCompat {
  readonly maxTokensField: 'max_tokens' | 'max_completion_tokens';
  readonly supportsTemperature: boolean;
  readonly supportsToolChoice: boolean;
  readonly supportsStrictMode: boolean;
  readonly requiresReasoningContentOnAssistantMessages: boolean;
  readonly requiresAssistantContentForToolCalls: boolean;
}

/** Resolve model-provided compatibility flags without inferring provider behavior. */
export function resolveOpenAiCompletionsCompat(
  model: Model,
): ResolvedOpenAiCompletionsCompat {
  const compat = model.compat;
  return {
    maxTokensField: compat?.maxTokensField ?? 'max_tokens',
    supportsTemperature: compat?.supportsTemperature ?? true,
    supportsToolChoice: compat?.supportsToolChoice ?? true,
    supportsStrictMode: compat?.supportsStrictMode ?? false,
    requiresReasoningContentOnAssistantMessages:
      compat?.requiresReasoningContentOnAssistantMessages ?? false,
    requiresAssistantContentForToolCalls:
      compat?.requiresAssistantContentForToolCalls ?? false,
  };
}
