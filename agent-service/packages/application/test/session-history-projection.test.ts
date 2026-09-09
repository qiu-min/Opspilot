import type { AgentMessage } from '@opspilot/agent-runtime';
import { describe, expect, it } from 'vitest';

import { buildSessionHistoryProjection, Session } from '../src/index.js';

function userMessage(text: string): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text }] };
}

function assistantMessage(text: string): AgentMessage {
  return {
    role: 'assistant',
    api: 'test-api',
    provider: 'test-provider',
    model: 'test-model',
    content: [{ type: 'text', text }],
    finishReason: 'stop',
  };
}

function visibleMessages(items: ReturnType<typeof buildSessionHistoryProjection>['items']) {
  return items.filter(
    (item): item is Extract<(typeof items)[number], { type: 'message' }> => item.type === 'message',
  );
}

describe('buildSessionHistoryProjection', () => {
  it('returns an empty projection for an empty session branch', () => {
    const session = Session.create();

    expect(buildSessionHistoryProjection(session.getBranch(), session.getLeafId())).toEqual({
      leafId: null,
      items: [],
    });
  });

  it('returns ordinary multi-turn user and assistant messages in branch order', () => {
    const session = Session.create();
    session.appendMessage(userMessage('user 1'));
    session.appendMessage(assistantMessage('assistant 1'));
    session.appendMessage(userMessage('user 2'));
    session.appendMessage(assistantMessage('assistant 2'));

    const projection = buildSessionHistoryProjection(session.getBranch(), session.getLeafId());

    expect(visibleMessages(projection.items).map((item) => [item.role, item.text])).toEqual([
      ['user', 'user 1'],
      ['assistant', 'assistant 1'],
      ['user', 'user 2'],
      ['assistant', 'assistant 2'],
    ]);
  });

  it('uses the source SessionMessageEntry id as the stable item id', () => {
    const session = Session.create();
    const entry = session.appendMessage(userMessage('stable'));

    const projection = buildSessionHistoryProjection(session.getBranch());

    expect(projection.items[0]?.id).toBe(entry.id);
  });

  it('ignores model, thinking-level, and compaction entries', () => {
    const session = Session.create();
    const message = session.appendMessage(userMessage('visible'));
    session.appendModelChange('provider', 'model');
    session.appendThinkingLevelChange('low');
    session.appendCompaction('summary must not be shown', message.id, 10);

    const projection = buildSessionHistoryProjection(session.getBranch());

    expect(visibleMessages(projection.items).map((item) => item.text)).toEqual(['visible']);
  });

  it('projects tool messages as UI-safe tool execution items', () => {
    const session = Session.create();
    session.appendMessage(userMessage('user'));
    const tool = session.appendMessage({
      role: 'tool',
      callId: 'call-1',
      name: 'lookup',
      content: [{ type: 'text', text: 'private tool output' }],
      isError: false,
    });

    const projection = buildSessionHistoryProjection(session.getBranch());

    expect(projection.items).toEqual([
      expect.objectContaining({ type: 'message', role: 'user', text: 'user' }),
      {
        type: 'tool_execution',
        id: tool.id,
        callId: 'call-1',
        name: 'lookup',
        status: 'completed',
        createdAt: expect.any(String),
      },
    ]);
  });

  it('keeps assistant and tool entries in their original order', () => {
    const session = Session.create();
    session.appendMessage(userMessage('question'));
    session.appendMessage({
      role: 'assistant',
      api: 'test-api',
      provider: 'test-provider',
      model: 'test-model',
      content: [],
      toolCalls: [{ callId: 'call-1', name: 'lookup', arguments: {} }],
      finishReason: 'tool_calls',
    });
    const tool = session.appendMessage({
      role: 'tool',
      callId: 'call-1',
      name: 'lookup',
      content: [{ type: 'text', text: 'private tool output' }],
      isError: false,
    });
    const finalAssistant = session.appendMessage(assistantMessage('final answer'));

    const projection = buildSessionHistoryProjection(session.getBranch());

    expect(projection.items.map((item) => item.type)).toEqual([
      'message',
      'tool_execution',
      'message',
    ]);
    expect(projection.items[1]).toMatchObject({
      type: 'tool_execution',
      id: tool.id,
      callId: 'call-1',
      name: 'lookup',
      status: 'completed',
    });
    expect(projection.items[2]).toMatchObject({
      type: 'message',
      role: 'assistant',
      text: 'final answer',
    });
  });

  it('exposes assistant text while excluding thinking content', () => {
    const session = Session.create();
    session.appendMessage({
      role: 'assistant',
      api: 'test-api',
      provider: 'test-provider',
      model: 'test-model',
      content: [
        {
          type: 'thinking',
          thinking: 'private reasoning',
          thinkingSignature: 'reasoning',
          source: { api: 'test-api', provider: 'test-provider', model: 'test-model' },
        },
        { type: 'text', text: 'public answer' },
      ],
      finishReason: 'stop',
    });

    const projection = buildSessionHistoryProjection(session.getBranch());

    expect(visibleMessages(projection.items)[0]?.text).toBe('public answer');
    expect(JSON.stringify(projection)).not.toContain('private reasoning');
  });

  it('keeps the complete original history after compaction', () => {
    const session = Session.create();
    const oldUser = session.appendMessage(userMessage('old user'));
    const oldAssistant = session.appendMessage(assistantMessage('old assistant'));
    const newUser = session.appendMessage(userMessage('new user'));
    const newAssistant = session.appendMessage(assistantMessage('new assistant'));
    session.appendCompaction('summary must not replace original messages', newUser.id, 42);

    const projection = buildSessionHistoryProjection(session.getBranch());

    expect(projection.items.map((item) => item.id)).toEqual([
      oldUser.id,
      oldAssistant.id,
      newUser.id,
      newAssistant.id,
    ]);
    expect(visibleMessages(projection.items).map((item) => item.text)).toEqual([
      'old user',
      'old assistant',
      'new user',
      'new assistant',
    ]);
  });

  it('returns only the active branch when the session has branching history', () => {
    const session = Session.create();
    const a = session.appendMessage(userMessage('A'));
    const b = session.appendMessage(assistantMessage('B'));
    const c = session.appendMessage(assistantMessage('C'));
    session.branch(b.id);
    const d = session.appendMessage(assistantMessage('D'));

    const projection = buildSessionHistoryProjection(session.getBranch());

    expect(visibleMessages(projection.items).map((item) => item.text)).toEqual(['A', 'B', 'D']);
    expect(projection.leafId).toBe(d.id);
    expect(projection.items.map((item) => item.id)).not.toContain(c.id);
  });
});
