import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@opspilot/agent-runtime';
import type { AssistantMessage, Usage } from '@opspilot/model-gateway';

import {
  buildSessionMessageProjection,
  calculateContextTokens,
  DEFAULT_COMPACTION_SETTINGS,
  estimateContextTokens,
  estimateSessionContextTokens,
  estimateTokens,
  SessionManager,
  shouldCompact,
} from '../src/index.js';

function userMessage(text: string): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text }] };
}

function assistantMessage(
  content: AssistantMessage['content'],
  options: Pick<AssistantMessage, 'finishReason' | 'usage'> = { finishReason: 'stop' },
): AssistantMessage {
  return {
    role: 'assistant',
    api: 'test-api',
    provider: 'test-provider',
    model: 'test-model',
    content,
    finishReason: options.finishReason,
    ...(options.usage === undefined ? {} : { usage: options.usage }),
  };
}

function usage(inputTokens: number, outputTokens: number, totalTokens: number): Usage {
  return { inputTokens, outputTokens, totalTokens };
}

describe('Context Accounting', () => {
  describe('calculateContextTokens', () => {
    it('prefers a non-zero totalTokens value', () => {
      expect(calculateContextTokens(usage(100, 200, 500))).toBe(500);
    });

    it('falls back to inputTokens plus outputTokens when totalTokens is zero', () => {
      expect(calculateContextTokens(usage(100, 200, 0))).toBe(300);
    });
  });

  describe('estimateTokens', () => {
    it('estimates user text using all text content characters', () => {
      expect(estimateTokens(userMessage('hello'))).toBe(2);
    });

    it('estimates assistant text, thinking, and tool calls', () => {
      const message = assistantMessage([
        { type: 'text', text: 'text' },
        {
          type: 'thinking',
          thinking: 'think',
          thinkingSignature: 'reasoning',
          source: { api: 'test-api', provider: 'test-provider', model: 'test-model' },
        },
      ]);
      const withToolCall: AssistantMessage = {
        ...message,
        toolCalls: [{ callId: 'call-1', name: 'lookup', arguments: { query: 'value' } }],
      };

      expect(estimateTokens(withToolCall)).toBe(
        Math.ceil(('text'.length + 'think'.length + 'lookup'.length + 17) / 4),
      );
    });

    it('estimates tool result text and empty content', () => {
      const toolResult: AgentMessage = {
        role: 'tool',
        callId: 'call-1',
        name: 'lookup',
        content: [{ type: 'text', text: 'result' }],
        isError: false,
      };
      const emptyAssistant = assistantMessage([]);

      expect(estimateTokens(toolResult)).toBe(2);
      expect(estimateTokens(emptyAssistant)).toBe(0);
    });

    it('does not modify the original message', () => {
      const message = assistantMessage([{ type: 'text', text: 'unchanged' }], {
        finishReason: 'stop',
        usage: usage(10, 2, 12),
      });
      const snapshot = structuredClone(message);

      estimateTokens(message);

      expect(message).toEqual(snapshot);
    });

    it('uses a safe fallback for an unknown custom message', () => {
      const customMessage = {
        role: 'custom',
        payload: { text: 'custom' },
      } as unknown as AgentMessage;
      const cyclicValue: { role: string; self?: unknown } = { role: 'custom' };
      cyclicValue.self = cyclicValue;

      expect(estimateTokens(customMessage)).toBe(
        Math.ceil(JSON.stringify(customMessage).length / 4),
      );
      expect(() => estimateTokens(cyclicValue as AgentMessage)).not.toThrow();
      expect(estimateTokens(cyclicValue as AgentMessage)).toBe(0);
    });
  });

  describe('estimateContextTokens', () => {
    it('estimates all messages when no valid usage exists', () => {
      const messages = [userMessage('four'), userMessage('five5')];
      const estimated = estimateTokens(messages[0]) + estimateTokens(messages[1]);

      expect(estimateContextTokens(messages)).toEqual({
        tokens: estimated,
        usageTokens: 0,
        trailingTokens: estimated,
        lastUsageIndex: null,
      });
    });

    it('uses the latest valid assistant usage and estimates only trailing messages', () => {
      const messages: AgentMessage[] = [
        userMessage('A'),
        assistantMessage([{ type: 'text', text: 'B' }], {
          finishReason: 'stop',
          usage: usage(100, 200, 5000),
        }),
        userMessage('C'),
      ];

      expect(estimateContextTokens(messages)).toEqual({
        tokens: 5001,
        usageTokens: 5000,
        trailingTokens: 1,
        lastUsageIndex: 1,
      });
    });

    it('uses the last valid usage when multiple assistant messages report usage', () => {
      const messages: AgentMessage[] = [
        userMessage('A'),
        assistantMessage([], { finishReason: 'stop', usage: usage(1, 1, 5000) }),
        userMessage('B'),
        assistantMessage([], { finishReason: 'stop', usage: usage(1, 1, 7000) }),
        userMessage('C'),
      ];

      expect(estimateContextTokens(messages)).toEqual({
        tokens: 7001,
        usageTokens: 7000,
        trailingTokens: 1,
        lastUsageIndex: 3,
      });
    });

    it.each([
      ['error', 'error', 9999],
      ['aborted', 'aborted', 9999],
      ['zero usage', 'stop', 0],
    ] as const)('ignores %s assistant usage', (_label, finishReason, totalTokens) => {
      const messages: AgentMessage[] = [
        userMessage('A'),
        assistantMessage([], { finishReason: 'stop', usage: usage(1, 1, 5000) }),
        assistantMessage([], {
          finishReason,
          usage: usage(0, 0, totalTokens),
        }),
        userMessage('C'),
      ];

      expect(estimateContextTokens(messages)).toEqual({
        tokens: 5001,
        usageTokens: 5000,
        trailingTokens: 1,
        lastUsageIndex: 1,
      });
    });
  });

  describe('estimateSessionContextTokens', () => {
    it('preserves the existing accounting behavior when there is no compaction', () => {
      const session = SessionManager.inMemory();
      session.appendMessage(userMessage('A'));
      const assistant = session.appendMessage(
        assistantMessage([{ type: 'text', text: 'B' }], {
          finishReason: 'stop',
          usage: usage(100, 200, 5000),
        }),
      );
      session.appendMessage(userMessage('C'));

      expect(estimateSessionContextTokens(session.getBranch())).toEqual(
        estimateContextTokens([userMessage('A'), assistant.message, userMessage('C')]),
      );
    });

    it('falls back to the projected message estimate when usage predates compaction', () => {
      const session = SessionManager.inMemory();
      session.appendMessage(userMessage('old history'));
      const oldAssistant = session.appendMessage(
        assistantMessage([{ type: 'text', text: 'old answer' }], {
          finishReason: 'stop',
          usage: usage(1, 1, 100_000),
        }),
      );
      session.appendCompaction('old summary', oldAssistant.id, 100_000);
      session.appendMessage(userMessage('recent input'));
      session.appendMessage(assistantMessage([{ type: 'text', text: 'recent answer' }]));

      const projection = buildSessionMessageProjection(session.getBranch());
      const projectedMessages = projection.messages.map((item) => item.message);
      const estimatedProjectedTokens = projectedMessages.reduce(
        (total, message) => total + estimateTokens(message),
        0,
      );

      expect(estimateSessionContextTokens(session.getBranch())).toEqual({
        tokens: estimatedProjectedTokens,
        usageTokens: 0,
        trailingTokens: estimatedProjectedTokens,
        lastUsageIndex: null,
      });
    });

    it('uses a new assistant usage reported after compaction', () => {
      const session = SessionManager.inMemory();
      const kept = session.appendMessage(userMessage('kept input'));
      session.appendCompaction('summary', kept.id, 12);
      const recentAssistant = session.appendMessage(
        assistantMessage([{ type: 'text', text: 'recent answer' }], {
          finishReason: 'stop',
          usage: usage(10, 20, 3000),
        }),
      );
      const projection = buildSessionMessageProjection(session.getBranch());
      const recentIndex = projection.messages.findIndex(
        (item) => item.entryIndex === session.getEntries().findIndex((entry) => entry.id === recentAssistant.id),
      );

      expect(estimateSessionContextTokens(session.getBranch())).toEqual({
        tokens: 3000,
        usageTokens: 3000,
        trailingTokens: 0,
        lastUsageIndex: recentIndex,
      });
    });
  });

  describe('shouldCompact', () => {
    it('returns false when compaction is disabled', () => {
      expect(
        shouldCompact(200_000, 128_000, {
          ...DEFAULT_COMPACTION_SETTINGS,
          enabled: false,
        }),
      ).toBe(false);
    });

    it.each([
      [111_999, false],
      [112_000, false],
      [112_001, true],
    ])('uses a strict threshold comparison for %i context tokens', (contextTokens, expected) => {
      expect(
        shouldCompact(contextTokens, 128_000, {
          ...DEFAULT_COMPACTION_SETTINGS,
          reserveTokens: 16_000,
        }),
      ).toBe(expected);
    });
  });
});
