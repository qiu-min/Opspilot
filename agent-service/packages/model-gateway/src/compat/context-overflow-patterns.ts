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
  /exceed(?:s|ed) model token limit/i,
  /exceeds the model's maximum context/i,
  /exceeds model's maximum context/i,
  /exceeds (?:the )?maximum allowed input length/i,
  /context window exceeds limit/i,
  /maximum prompt length/i,
  /request_too_large/i,
  /model_context_window_exceeded/i,
  /reduce the length of the messages/i,
  /exceeds the available context size/i,
];

/** Error text patterns that identify throttling or rate limiting, not overflow. */
const NON_OVERFLOW_PATTERNS: readonly RegExp[] = [/rate limit/i, /too many requests/i, /throttl/i];

/** Reuses the compatibility patterns for raw Provider error messages. */
export function isContextOverflowErrorMessage(message: string): boolean {
  if (NON_OVERFLOW_PATTERNS.some((pattern) => pattern.test(message))) return false;
  return CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(message));
}
