import { describe, expect, it } from 'vitest';
import type { Message } from '@opspilot/model-gateway';

import { defaultConvertToLlm } from '../src/index.js';
import type { AgentMessage } from '../src/index.js';

declare module '../src/types.js' {
  interface CustomAgentMessages {
    testCustom: {
      readonly role: 'test-custom';
      readonly value: string;
    };
  }
}

describe('defaultConvertToLlm', () => {
  it('keeps standard messages and filters custom messages', () => {
    const standardMessage: Message = {
      role: 'user',
      content: [{ type: 'text', text: 'standard' }],
    };
    const customMessage: AgentMessage = {
      role: 'test-custom',
      value: 'only for the runtime',
    };

    expect(defaultConvertToLlm([standardMessage, customMessage])).toEqual([standardMessage]);
  });

  it('allows a caller converter to turn custom messages into LLM messages', () => {
    const customMessage: AgentMessage = {
      role: 'test-custom',
      value: 'database is healthy',
    };
    const converted = [customMessage].flatMap((message): Message[] => {
      if (
        typeof message === 'object' &&
        message !== null &&
        'role' in message &&
        message.role === 'test-custom'
      ) {
        return [
          {
            role: 'user',
            content: [{ type: 'text', text: `Evidence: ${message.value}` }],
          },
        ];
      }
      return [];
    });

    expect(converted).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'Evidence: database is healthy' }],
      },
    ]);
  });
});
