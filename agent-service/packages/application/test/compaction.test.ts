import { describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '@opspilot/agent-runtime';
import type {
  AssistantMessage,
  Context,
  Model,
  ModelGateway,
  ModelEventStream,
} from '@opspilot/model-gateway';

import {
  buildSessionMessageProjection,
  DefaultCompactionService,
  prepareCompaction,
  SessionManager,
  type CompactionSettings,
} from '../src/index.js';

const model: Model = {
  provider: 'test-provider',
  id: 'test-model',
  name: 'Test Model',
  api: 'test-api',
  baseUrl: 'https://model.example.test/v1',
  reasoning: false,
};

const settings: CompactionSettings = {
  enabled: true,
  reserveTokens: 0,
  keepRecentTokens: 1,
};

function userMessage(text: string): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text }] };
}

function assistantMessage(
  content: AssistantMessage['content'],
  options: Pick<AssistantMessage, 'finishReason' | 'usage'> = { finishReason: 'stop' },
): AssistantMessage {
  return {
    role: 'assistant',
    api: model.api,
    provider: model.provider,
    model: model.id,
    content,
    finishReason: options.finishReason,
    ...(options.usage === undefined ? {} : { usage: options.usage }),
  };
}

function toolResult(text: string): AgentMessage {
  return {
    role: 'tool',
    callId: 'call-1',
    name: 'lookup',
    content: [{ type: 'text', text }],
    isError: false,
  };
}

function createCompletionGateway(
  response: AssistantMessage,
): ModelGateway & { readonly complete: ReturnType<typeof vi.fn> } {
  const complete = vi.fn(async (_model: Model, _context: Context) => response);
  return {
    getProviders: () => [],
    getModels: () => [model],
    getModel: () => model,
    stream: (_model: Model, _context: Context): ModelEventStream => {
      throw new Error('stream is not used by the compaction service test.');
    },
    complete,
  };
}

describe('Compaction preparation and service', () => {
  it('uses one projection for plain, latest-compacted, repeated, and branched history', () => {
    const session = SessionManager.inMemory();
    const first = session.appendMessage(userMessage('A'));
    const kept = session.appendMessage(assistantMessage([{ type: 'text', text: 'B' }]));
    session.appendCompaction('summary one', kept.id, 10);
    const recent = session.appendMessage(userMessage('C'));

    const compactedProjection = buildSessionMessageProjection(session.getBranch());
    expect(compactedProjection.messages.map((item) => item.message)).toEqual([
      expect.objectContaining({
        role: 'user',
        content: [expect.objectContaining({ text: expect.stringContaining('summary one') })],
      }),
      kept.message,
      recent.message,
    ]);

    const secondCompaction = session.appendCompaction('summary two', recent.id, 20);
    const repeatedProjection = buildSessionMessageProjection(session.getBranch());
    expect(repeatedProjection.messages.map((item) => item.message)).toEqual([
      expect.objectContaining({
        role: 'user',
        content: [expect.objectContaining({ text: expect.stringContaining('summary two') })],
      }),
      recent.message,
    ]);
    expect(secondCompaction.firstKeptEntryId).toBe(recent.id);

    session.branch(first.id);
    const branched = session.appendMessage(userMessage('branch'));
    const branchProjection = buildSessionMessageProjection(session.getBranch());
    expect(branchProjection.latestCompactionIndex).toBeNull();
    expect(branchProjection.messages.map((item) => item.message)).toEqual([
      first.message,
      branched.message,
    ]);
  });

  it('does not prepare compaction when the history is shorter than keepRecentTokens', () => {
    const session = SessionManager.inMemory();
    session.appendMessage(userMessage('A'));
    session.appendMessage(assistantMessage([{ type: 'text', text: 'B' }]));

    expect(
      prepareCompaction(session.getBranch(), {
        ...settings,
        keepRecentTokens: 100,
      }),
    ).toBeUndefined();
  });

  it('chooses an assistant cut point instead of starting with a tool result', () => {
    const session = SessionManager.inMemory();
    session.appendMessage(userMessage('A'));
    const assistant = session.appendMessage(
      assistantMessage([], {
        finishReason: 'tool_calls',
      }),
    );
    session.appendMessage(toolResult('tool output'));

    const preparation = prepareCompaction(session.getBranch(), {
      ...settings,
      keepRecentTokens: 3,
    });

    expect(preparation).toMatchObject({
      firstKeptEntryId: assistant.id,
      messagesToSummarize: [userMessage('A')],
    });
    expect(preparation?.firstKeptEntryId).not.toBe(
      session
        .getEntries()
        .find((entry) => entry.type === 'message' && entry.message.role === 'tool')?.id,
    );
  });

  it('includes the previous summary without re-expanding compacted history', () => {
    const session = SessionManager.inMemory();
    session.appendMessage(userMessage('A'));
    const kept = session.appendMessage(assistantMessage([{ type: 'text', text: 'B' }]));
    session.appendCompaction('summary one', kept.id, 10);
    session.appendMessage(userMessage('C'));
    const keptNext = session.appendMessage(assistantMessage([{ type: 'text', text: 'D' }]));

    const preparation = prepareCompaction(session.getBranch(), settings);

    expect(preparation).toMatchObject({
      firstKeptEntryId: keptNext.id,
      messagesToSummarize: [
        expect.objectContaining({
          role: 'user',
          content: [expect.objectContaining({ text: expect.stringContaining('summary one') })],
        }),
        assistantMessage([{ type: 'text', text: 'B' }]),
        userMessage('C'),
      ],
    });
  });

  it('calls ModelGateway.complete with supplied messages and returns only the summary', async () => {
    const session = SessionManager.inMemory();
    session.appendMessage(userMessage('user goal'));
    session.appendMessage({
      ...assistantMessage([
        { type: 'text', text: 'assistant answer' },
        {
          type: 'thinking',
          thinking: 'assistant reasoning',
          thinkingSignature: 'reasoning',
          source: { api: model.api, provider: model.provider, model: model.id },
        },
      ]),
      toolCalls: [{ callId: 'call-1', name: 'lookup', arguments: { query: 'value' } }],
    });
    session.appendMessage(toolResult('tool answer'));
    const kept = session.appendMessage(userMessage('recent input'));
    const preparation = prepareCompaction(session.getBranch(), settings);
    expect(preparation).toBeDefined();
    const gateway = createCompletionGateway(assistantMessage([{ type: 'text', text: 'summary' }]));
    const service = new DefaultCompactionService(gateway);

    const result = await service.compact({
      messages: preparation!.messagesToSummarize,
      model,
    });

    expect(result).toEqual({ summary: 'summary' });
    expect(preparation?.firstKeptEntryId).toBe(kept.id);
    expect(gateway.complete).toHaveBeenCalledOnce();
    const context = gateway.complete.mock.calls[0]?.[1] as Context;
    const transcript =
      context.messages[0]?.role === 'user' ? context.messages[0].content[0].text : '';
    expect(transcript).toContain('user goal');
    expect(transcript).toContain('assistant answer');
    expect(transcript).toContain('assistant reasoning');
    expect(transcript).toContain('Tool call lookup');
    expect(transcript).toContain('{"query":"value"}');
    expect(transcript).toContain('tool answer');
    expect(transcript).not.toContain('recent input');
  });

  it.each([
    ['error', 'error', []],
    ['aborted', 'aborted', []],
    ['empty summary', 'stop', []],
  ] as const)('rejects a %s summary response', async (_label, finishReason, content) => {
    const session = SessionManager.inMemory();
    session.appendMessage(userMessage('old'));
    session.appendMessage(assistantMessage([{ type: 'text', text: 'recent' }]));
    const gateway = createCompletionGateway(assistantMessage(content, { finishReason }));
    const service = new DefaultCompactionService(gateway);
    const preparation = prepareCompaction(session.getBranch(), settings);
    expect(preparation).toBeDefined();

    await expect(
      service.compact({ messages: preparation!.messagesToSummarize, model }),
    ).rejects.toThrow('Compaction');
  });

  it('does not mutate the SessionManager while generating a summary', async () => {
    const session = SessionManager.inMemory();
    session.appendMessage(userMessage('old'));
    session.appendMessage(assistantMessage([{ type: 'text', text: 'recent' }]));
    const before = session.getEntries();
    const service = new DefaultCompactionService(
      createCompletionGateway(assistantMessage([{ type: 'text', text: 'summary' }])),
    );
    const preparation = prepareCompaction(session.getBranch(), settings);
    expect(preparation).toBeDefined();

    await service.compact({ messages: preparation!.messagesToSummarize, model });

    expect(session.getEntries()).toEqual(before);
  });
});
