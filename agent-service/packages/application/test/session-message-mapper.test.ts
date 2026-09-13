import { describe, expect, it } from 'vitest';

import type { AssistantMessage } from '@opspilot/model-gateway';

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
