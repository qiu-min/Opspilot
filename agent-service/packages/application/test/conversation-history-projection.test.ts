import type { AgentMessage } from '@opspilot/agent-runtime';
import { describe, expect, it } from 'vitest';

import { buildConversationHistoryProjection, SessionManager } from '../src/index.js';

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

describe('buildConversationHistoryProjection', () => {
  it('returns an empty projection for an empty session branch', () => {
    const session = SessionManager.inMemory();

    expect(buildConversationHistoryProjection(session.getBranch(), session.getLeafId())).toEqual({
      leafId: null,
      items: [],
    });
  });

  it('returns ordinary multi-turn user and assistant messages in branch order', () => {
    const session = SessionManager.inMemory();
    session.appendMessage(userMessage('user 1'));
    session.appendMessage(assistantMessage('assistant 1'));
    session.appendMessage(userMessage('user 2'));
    session.appendMessage(assistantMessage('assistant 2'));

    const projection = buildConversationHistoryProjection(session.getBranch(), session.getLeafId());

    expect(projection.items.map((item) => [item.role, item.text])).toEqual([
      ['user', 'user 1'],
      ['assistant', 'assistant 1'],
      ['user', 'user 2'],
      ['assistant', 'assistant 2'],
    ]);
  });

  it('uses the source SessionMessageEntry id as the stable item id', () => {
    const session = SessionManager.inMemory();
    const entry = session.appendMessage(userMessage('stable'));

    const projection = buildConversationHistoryProjection(session.getBranch());

    expect(projection.items[0]?.id).toBe(entry.id);
  });

  it('ignores model, thinking-level, and compaction entries', () => {
    const session = SessionManager.inMemory();
    const message = session.appendMessage(userMessage('visible'));
    session.appendModelChange('provider', 'model');
    session.appendThinkingLevelChange('low');
    session.appendCompaction('summary must not be shown', message.id, 10);

    const projection = buildConversationHistoryProjection(session.getBranch());

    expect(projection.items.map((item) => item.text)).toEqual(['visible']);
  });

  it('ignores tool messages instead of mapping them as assistant messages', () => {
    const session = SessionManager.inMemory();
    session.appendMessage(userMessage('user'));
    session.appendMessage({
      role: 'tool',
      callId: 'call-1',
      name: 'lookup',
      content: [{ type: 'text', text: 'private tool output' }],
      isError: false,
    });

    const projection = buildConversationHistoryProjection(session.getBranch());

    expect(projection.items.map((item) => item.text)).toEqual(['user']);
  });

  it('exposes assistant text while excluding thinking content', () => {
    const session = SessionManager.inMemory();
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

    const projection = buildConversationHistoryProjection(session.getBranch());

    expect(projection.items[0]?.text).toBe('public answer');
    expect(JSON.stringify(projection)).not.toContain('private reasoning');
  });

  it('keeps the complete original history after compaction', () => {
    const session = SessionManager.inMemory();
    const oldUser = session.appendMessage(userMessage('old user'));
    const oldAssistant = session.appendMessage(assistantMessage('old assistant'));
    const newUser = session.appendMessage(userMessage('new user'));
    const newAssistant = session.appendMessage(assistantMessage('new assistant'));
    session.appendCompaction('summary must not replace original messages', newUser.id, 42);

    const projection = buildConversationHistoryProjection(session.getBranch());

    expect(projection.items.map((item) => item.id)).toEqual([
      oldUser.id,
      oldAssistant.id,
      newUser.id,
      newAssistant.id,
    ]);
    expect(projection.items.map((item) => item.text)).toEqual([
      'old user',
      'old assistant',
      'new user',
      'new assistant',
    ]);
  });

  it('returns only the active branch when the session has branching history', () => {
    const session = SessionManager.inMemory();
    const a = session.appendMessage(userMessage('A'));
    const b = session.appendMessage(assistantMessage('B'));
    const c = session.appendMessage(assistantMessage('C'));
    session.branch(b.id);
    const d = session.appendMessage(assistantMessage('D'));

    const projection = buildConversationHistoryProjection(session.getBranch());

    expect(projection.items.map((item) => item.text)).toEqual(['A', 'B', 'D']);
    expect(projection.leafId).toBe(d.id);
    expect(projection.items.map((item) => item.id)).not.toContain(c.id);
  });
});
