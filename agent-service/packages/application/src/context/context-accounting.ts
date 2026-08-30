import type { AgentMessage } from '@opspilot/agent-runtime';
import type { AssistantMessage, TextContent, Usage } from '@opspilot/model-gateway';

import type { CompactionSettings } from './compaction-settings.js';

const TOKENS_PER_ESTIMATED_CHARACTER = 4;

/** Result of estimating the context size represented by a message list. */
export interface ContextUsageEstimate {
  readonly tokens: number;
  readonly usageTokens: number;
  readonly trailingTokens: number;
  readonly lastUsageIndex: number | null;
}

/** Calculates context tokens from provider usage, falling back to input plus output. */
export function calculateContextTokens(usage: Usage): number {
  if (Number.isFinite(usage.totalTokens) && usage.totalTokens > 0) {
    return usage.totalTokens;
  }

  return usage.inputTokens + usage.outputTokens;
}

/** Estimates one AgentMessage using a stable four-characters-per-token heuristic. */
export function estimateTokens(message: AgentMessage): number {
  try {
    if (message.role === 'user') {
      return estimateCharacterCount(countTextCharacters(message.content));
    }

    if (message.role === 'assistant') {
      return estimateCharacterCount(countAssistantCharacters(message));
    }

    if (message.role === 'tool') {
      return estimateCharacterCount(countTextCharacters(message.content));
    }

    return estimateCharacterCount(countFallbackCharacters(message));
  } catch {
    return 0;
  }
}

/** Estimates context tokens without double-counting the history covered by usage. */
export function estimateContextTokens(
  messages: readonly AgentMessage[],
): ContextUsageEstimate {
  const usageInfo = findLastAssistantUsage(messages);

  if (usageInfo === undefined) {
    const estimated = messages.reduce((total, message) => total + estimateTokens(message), 0);
    return {
      tokens: estimated,
      usageTokens: 0,
      trailingTokens: estimated,
      lastUsageIndex: null,
    };
  }

  const usageTokens = calculateContextTokens(usageInfo.usage);
  let trailingTokens = 0;
  for (let index = usageInfo.index + 1; index < messages.length; index += 1) {
    trailingTokens += estimateTokens(messages[index]);
  }

  return {
    tokens: usageTokens + trailingTokens,
    usageTokens,
    trailingTokens,
    lastUsageIndex: usageInfo.index,
  };
}

/** Returns whether context usage is beyond the configured compaction threshold. */
export function shouldCompact(
  contextTokens: number,
  contextWindow: number,
  settings: CompactionSettings,
): boolean {
  if (!settings.enabled) return false;
  return contextTokens > contextWindow - settings.reserveTokens;
}

function findLastAssistantUsage(
  messages: readonly AgentMessage[],
): { readonly usage: Usage; readonly index: number } | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const usage = getValidAssistantUsage(messages[index]);
    if (usage !== undefined) return { usage, index };
  }

  return undefined;
}

function getValidAssistantUsage(message: AgentMessage): Usage | undefined {
  if (message.role !== 'assistant') return undefined;
  if (message.finishReason === 'error' || message.finishReason === 'aborted') return undefined;

  const usage = message.usage;
  if (usage === undefined || calculateContextTokens(usage) <= 0) return undefined;
  return usage;
}

function countAssistantCharacters(message: AssistantMessage): number {
  let characters = 0;

  for (const content of message.content) {
    if (content.type === 'text') characters += content.text.length;
    else if (content.type === 'thinking') characters += content.thinking.length;
  }

  for (const toolCall of message.toolCalls ?? []) {
    const serializedArguments = serializeSafely(toolCall.arguments);
    characters += toolCall.name.length + (serializedArguments?.length ?? 0);
  }

  return characters;
}

function countTextCharacters(content: readonly TextContent[]): number {
  return content.reduce((characters, block) => characters + block.text.length, 0);
}

function countFallbackCharacters(value: unknown): number {
  const serialized = serializeSafely(value);
  return serialized?.length ?? 0;
}

function serializeSafely(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function estimateCharacterCount(characters: number): number {
  return Math.ceil(characters / TOKENS_PER_ESTIMATED_CHARACTER);
}
