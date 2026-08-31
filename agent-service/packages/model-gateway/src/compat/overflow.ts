import type { AssistantMessage } from '../contracts/context.js';

/** Error text patterns commonly returned when a request exceeds a model context window. */
const CONTEXT_OVERFLOW_PATTERNS: readonly RegExp[] = [
  /context[_ ]length[_ ]exceeded/i,
  /maximum context length/i,
  /context length exceeded/i,
  /input exceeds the context window/i,
  /too many tokens/i,
  /prompt is too long/i,
  /prompt too long/i,
  /input token count[^\n]*exceeds/i,
  /exceeds the model's maximum context/i,
  /exceeds model's maximum context/i,
  /exceeds (?:the )?maximum allowed input length/i,
  /request_too_large/i,
  /model_context_window_exceeded/i,
  /reduce the length of the messages/i,
  /exceeds the available context size/i,
];

/**
 * Identifies an assistant response that indicates the model context was too large.
 *
 * Explicit provider error text is preferred. A positive usage input count may also
 * identify providers that accept an oversized request and report it only in usage.
 */
export function isContextOverflow(
  message: AssistantMessage,
  contextWindow?: number,
): boolean {
  if (message.finishReason === 'aborted') return false;

  if (
    message.finishReason === 'error' &&
    message.errorMessage !== undefined &&
    CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(message.errorMessage!))
  ) {
    return true;
  }

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
