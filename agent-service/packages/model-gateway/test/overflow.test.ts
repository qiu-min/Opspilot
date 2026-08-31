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
    'Your request exceeded model token limit: 1001 (requested: 1001)',
    'invalid params, context window exceeds limit',
    'This model\'s maximum prompt length is 1000 tokens.',
    'model_context_window_exceeded',
    'request_too_large',
    'Please reduce the length of the messages or completion',
    'The request exceeds the available context size',
  ])('recognizes %s error text', (errorMessage) => {
    expect(isContextOverflow({ ...baseMessage, errorMessage })).toBe(true);
  });

  it.each([
    'Too many tokens, please wait and retry due to rate limit',
    'Too many requests; please try again later',
    'ThrottlingException: Too many tokens, please wait before trying again',
  ])('does not classify %s as overflow', (errorMessage) => {
    expect(isContextOverflow({ ...baseMessage, errorMessage })).toBe(false);
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

  it('does not use excessive usage as a fallback for an error response', () => {
    expect(
      isContextOverflow(
        {
          ...baseMessage,
          errorMessage: 'server unavailable',
          usage: { inputTokens: 10_001, outputTokens: 0, totalTokens: 10_001 },
        },
        10_000,
      ),
    ).toBe(false);
  });

  it('does not use excessive usage as a fallback for a length response', () => {
    expect(
      isContextOverflow(
        {
          ...baseMessage,
          finishReason: 'length',
          usage: { inputTokens: 10_001, outputTokens: 0, totalTokens: 10_001 },
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
