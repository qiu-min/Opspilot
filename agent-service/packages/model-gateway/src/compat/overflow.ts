import type { AssistantMessage } from '../contracts/context.js';
import { isContextOverflowErrorMessage } from './context-overflow-patterns.js';

/**
 * Identifies an assistant response that indicates the model context was too large.
 *
 * Explicit provider error text is preferred. A positive usage input count may also
 * identify providers that accept an oversized request and report it only in usage.
 */
export function isContextOverflow(message: AssistantMessage, contextWindow?: number): boolean {
  if (message.finishReason === 'aborted') return false;

  if (message.modelError?.kind === 'context_overflow') return true;
  if (message.modelError !== undefined) return false;

  const errorMessage = message.errorMessage;

  if (
    message.finishReason === 'error' &&
    errorMessage !== undefined &&
    isContextOverflowErrorMessage(errorMessage)
  ) {
    return true;
  }

  if (message.finishReason !== 'stop') return false;

  const inputTokens = message.usage?.inputTokens;
  if (
    inputTokens === undefined ||
    !Number.isFinite(inputTokens) ||
    inputTokens <= 0 ||
    contextWindow === undefined ||
    !Number.isFinite(contextWindow) ||
    contextWindow <= 0
  ) {
    return false;
  }

  return inputTokens > contextWindow;
}
