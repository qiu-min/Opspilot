import { describe, expect, it } from 'vitest';

import type { AssistantMessage, ToolResultMessage } from '@opspilot/model-gateway';

import { toAgentMessage, toSessionMessage } from '../src/session/runtime/session-message-mapper.js';

const baseMessage: AssistantMessage = {
  role: 'assistant',
  api: 'openai-completions',
  provider: 'moonshot',
  model: 'kimi',
  content: [],
  finishReason: 'error',
  errorMessage: 'Model provider rate limit exceeded.',
  modelError: {
    kind: 'rate_limit',
    code: 'MODEL_RATE_LIMIT',
    message: 'Model provider rate limit exceeded.',
    retryable: true,
    statusCode: 429,
    providerCode: 'rate_limit_exceeded',
  },
};

describe('session message model error persistence', () => {
  it('round-trips modelError through the domain-owned Session message snapshot', () => {
    const sessionMessage = toSessionMessage(baseMessage);

    expect(sessionMessage).toMatchObject({ modelError: baseMessage.modelError });
    expect(toAgentMessage(sessionMessage!)).toEqual(baseMessage);
  });

  it('loads legacy assistant messages without modelError', () => {
    const legacyMessage: AssistantMessage = {
      ...baseMessage,
      modelError: undefined,
    };
    const sessionMessage = toSessionMessage(legacyMessage);

    expect(sessionMessage).toEqual(legacyMessage);
    expect(toAgentMessage(sessionMessage!)).toEqual(legacyMessage);
  });
});

describe('Session ToolResult persistence', () => {
  it('drops machine-only details while preserving the LLM-facing result', () => {
    const runtimeMessage: ToolResultMessage = {
      role: 'tool',
      callId: 'call-1',
      name: 'aggregate_data',
      content: [{ type: 'text', text: 'Aggregated 120 rows.' }],
      details: { rows: [['South', 92_726.94]] },
      isError: false,
    };

    const persistedMessage = toSessionMessage(runtimeMessage);

    expect(persistedMessage).toEqual({
      role: 'tool',
      callId: 'call-1',
      name: 'aggregate_data',
      content: [{ type: 'text', text: 'Aggregated 120 rows.' }],
      isError: false,
    });
    expect('details' in persistedMessage!).toBe(false);
    expect(toAgentMessage(persistedMessage!)).toEqual({
      role: 'tool',
      callId: 'call-1',
      name: 'aggregate_data',
      content: [{ type: 'text', text: 'Aggregated 120 rows.' }],
      isError: false,
    });
  });

  it('does not hydrate legacy Session ToolResult details into Runtime context', () => {
    const legacyMessage = {
      role: 'tool' as const,
      callId: 'call-legacy',
      name: 'lookup',
      content: [{ type: 'text' as const, text: 'legacy result' }],
      details: { kind: 'recoverable' },
      isError: true,
    };

    expect(toAgentMessage(legacyMessage)).toEqual({
      role: 'tool',
      callId: 'call-legacy',
      name: 'lookup',
      content: [{ type: 'text', text: 'legacy result' }],
      isError: true,
    });
  });
});
