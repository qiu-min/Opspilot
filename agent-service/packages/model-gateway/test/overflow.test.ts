import { describe, expect, it } from 'vitest';

import { isContextOverflow, type AssistantMessage } from '../src/index.js';

const baseMessage: AssistantMessage = {
  role: 'assistant',
  api: 'openai-completions',
  provider: 'test-provider',
  model: 'test-model',
  content: [],
  finishReason: 'error',
};

describe('isContextOverflow', () => {
  it.each([
    'context_length_exceeded',
    'The requested input exceeds the model\'s maximum context length.',
    'prompt is too long for this model',
    'The input token count (1001) exceeds the maximum number of tokens allowed.',
  ])('recognizes %s error text', (errorMessage) => {
    expect(isContextOverflow({ ...baseMessage, errorMessage })).toBe(true);
  });

  it('does not classify ordinary model errors as overflow', () => {
    expect(isContextOverflow({ ...baseMessage, errorMessage: 'server unavailable' })).toBe(false);
  });

  it('does not classify aborted responses as overflow', () => {
    expect(
      isContextOverflow({
        ...baseMessage,
        finishReason: 'aborted',
        errorMessage: 'context_length_exceeded',
        usage: { inputTokens: 10_001, outputTokens: 0, totalTokens: 10_001 },
      }, 10_000),
    ).toBe(false);
  });

  it('uses input usage as a fallback when it exceeds the context window', () => {
    expect(
      isContextOverflow(
        {
          ...baseMessage,
          finishReason: 'stop',
          usage: { inputTokens: 10_001, outputTokens: 10, totalTokens: 10_011 },
        },
        10_000,
      ),
    ).toBe(true);
  });

  it('does not classify usage at or below the context window', () => {
    expect(
      isContextOverflow(
        {
          ...baseMessage,
          finishReason: 'stop',
          usage: { inputTokens: 10_000, outputTokens: 10, totalTokens: 10_010 },
        },
        10_000,
      ),
    ).toBe(false);
  });

  it('does not use usage fallback without a context window', () => {
    expect(
      isContextOverflow({
        ...baseMessage,
        finishReason: 'stop',
        usage: { inputTokens: 10_001, outputTokens: 10, totalTokens: 10_011 },
      }),
    ).toBe(false);
  });
});
