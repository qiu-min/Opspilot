import type { ModelToolCall } from '@opspilot/model-gateway';
import {
  GetSessionHistory,
  Session,
  Turn,
  buildTurnPresentationSummary,
  type SessionStore,
  type ToolPresentationResolver,
  type TurnEvent,
  type TurnStore,
} from '../src/index.js';
import { describe, expect, it, vi } from 'vitest';

const sessionId = '11111111-1111-4111-8111-111111111111';
const startedAt = '2026-09-12T00:00:00.000Z';

describe('buildTurnPresentationSummary', () => {
  it('rebuilds completed timing, usage, tool lifecycle, and display from durable facts', () => {
    const session = Session.create({ id: sessionId, timestamp: startedAt });
    const input = session.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: 'inspect' }],
    });
    const toolCallOne: ModelToolCall = {
      callId: 'call-1',
      name: 'get_sheet_profile',
      arguments: { sheetName: 'Sheet1' },
    };
    const toolCallTwo: ModelToolCall = {
      callId: 'call-2',
      name: 'read_workbook',
      arguments: { workbook: 'book-1' },
    };
    const assistant = session.appendMessage({
      role: 'assistant',
      api: 'test-api',
      provider: 'test-provider',
      model: 'test-model',
      content: [],
      toolCalls: [toolCallOne, toolCallTwo],
      finishReason: 'tool_calls',
    });
    const turn = terminalTurn('turn-1', input.id, 'completed');
    const resolver = vi.fn<ToolPresentationResolver>(({ name, arguments: toolArguments }) => ({
      title: name === 'get_sheet_profile' ? 'Inspect Worksheet' : 'Read Workbook',
      subject: String(toolArguments.sheetName ?? toolArguments.workbook),
    }));

    const summary = buildTurnPresentationSummary({
      turn,
      session,
      toolPresentationResolver: resolver,
      events: [
        event(turn, 4, 'usage_recorded', {
          inputTokens: 1_600,
          outputTokens: 300,
          totalTokens: 1_900,
        }),
        event(turn, 0, 'assistant_message_completed', {
          entryId: assistant.id,
          sessionLeafId: assistant.id,
        }),
        event(turn, 2, 'tool_started', { callId: 'call-1', name: 'get_sheet_profile' }),
        event(turn, 1, 'tool_requested', { callId: 'call-1', name: 'get_sheet_profile' }),
        event(turn, 3, 'tool_completed', {
          callId: 'call-1',
          name: 'get_sheet_profile',
          isError: false,
          resultEntryId: 'tool-1',
          sessionLeafId: 'tool-1',
        }),
        event(turn, 5, 'usage_recorded', {
          inputTokens: 1_000,
          outputTokens: 100,
          totalTokens: 1_100,
        }),
        event(turn, 6, 'tool_requested', { callId: 'call-2', name: 'read_workbook' }),
        event(turn, 7, 'tool_completed', {
          callId: 'call-2',
          name: 'read_workbook',
          isError: true,
          resultEntryId: 'tool-2',
          sessionLeafId: 'tool-2',
        }),
      ],
    });

    expect(summary).toEqual({
      turnId: 'turn-1',
      sessionId,
      inputEntryId: input.id,
      status: 'completed',
      startedAt,
      completedAt: '2026-09-12T00:00:05.000Z',
      usage: { inputTokens: 2_600, outputTokens: 400, totalTokens: 3_000 },
      tools: [
        {
          callId: 'call-1',
          name: 'get_sheet_profile',
          status: 'completed',
          display: { title: 'Inspect Worksheet', subject: 'Sheet1' },
          startedAt: '2026-09-12T00:00:02.000Z',
          completedAt: '2026-09-12T00:00:03.000Z',
        },
        {
          callId: 'call-2',
          name: 'read_workbook',
          status: 'failed',
          display: { title: 'Read Workbook', subject: 'book-1' },
          completedAt: '2026-09-12T00:00:07.000Z',
        },
      ],
    });
    expect(resolver).toHaveBeenCalledWith({
      name: 'get_sheet_profile',
      arguments: { sheetName: 'Sheet1' },
    });
    expect(resolver).toHaveBeenCalledWith({
      name: 'read_workbook',
      arguments: { workbook: 'book-1' },
    });
  });

  it('deduplicates recovery attempts and uses the first start with the final completion', () => {
    const session = Session.create({ id: sessionId, timestamp: startedAt });
    const input = session.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: 'recover' }],
    });
    const firstAssistant = session.appendMessage({
      role: 'assistant',
      api: 'test-api',
      provider: 'test-provider',
      model: 'test-model',
      content: [],
      toolCalls: [
        { callId: 'call-recovered', name: 'lookup_a', arguments: { source: 'attempt-a' } },
      ],
      finishReason: 'tool_calls',
    });
    const secondAssistant = session.appendMessage({
      role: 'assistant',
      api: 'test-api',
      provider: 'test-provider',
      model: 'test-model',
      content: [],
      toolCalls: [
        { callId: 'call-recovered', name: 'lookup_b', arguments: { source: 'attempt-b' } },
      ],
      finishReason: 'tool_calls',
    });
    const turn = terminalTurn('turn-recovery', input.id, 'completed');
    const resolver = vi.fn<ToolPresentationResolver>(({ name, arguments: toolArguments }) => ({
      title: `${name}:${String(toolArguments.source)}`,
    }));

    const summary = buildTurnPresentationSummary({
      turn,
      session,
      toolPresentationResolver: resolver,
      events: [
        event(
          turn,
          0,
          'assistant_message_completed',
          { entryId: firstAssistant.id, sessionLeafId: firstAssistant.id },
          1,
        ),
        event(turn, 1, 'tool_started', { callId: 'call-recovered', name: 'lookup_a' }, 1),
        event(
          turn,
          2,
          'assistant_message_completed',
          { entryId: secondAssistant.id, sessionLeafId: secondAssistant.id },
          2,
        ),
        event(
          turn,
          3,
          'tool_completed',
          {
            callId: 'call-recovered',
            name: 'lookup_b',
            isError: false,
            resultEntryId: 'tool-recovered',
            sessionLeafId: 'tool-recovered',
          },
          2,
        ),
      ],
    });

    expect(summary?.tools).toEqual([
      {
        callId: 'call-recovered',
        name: 'lookup_a',
        status: 'completed',
        display: { title: 'lookup_a:attempt-a' },
        startedAt: '2026-09-12T00:00:01.000Z',
        completedAt: '2026-09-12T00:00:03.000Z',
      },
    ]);
    expect(resolver).toHaveBeenCalledOnce();
  });

  it('falls back safely for missing persisted ToolCall and resolver failures', () => {
    const session = Session.create({ id: sessionId, timestamp: startedAt });
    const input = session.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: 'unknown' }],
    });
    const assistant = session.appendMessage({
      role: 'assistant',
      api: 'test-api',
      provider: 'test-provider',
      model: 'test-model',
      content: [],
      finishReason: 'tool_calls',
    });
    const turn = terminalTurn('turn-fallback', input.id, 'failed');

    const summary = buildTurnPresentationSummary({
      turn,
      session,
      toolPresentationResolver: () => {
        throw new Error('resolver failed');
      },
      events: [
        event(turn, 0, 'assistant_message_completed', {
          entryId: assistant.id,
          sessionLeafId: assistant.id,
        }),
        event(turn, 1, 'tool_requested', { callId: 'call-missing', name: 'unknown_tool' }),
        event(turn, 2, 'tool_completed', {
          callId: 'call-missing',
          name: 'unknown_tool',
          isError: true,
          resultEntryId: 'tool-missing',
          sessionLeafId: 'tool-missing',
        }),
      ],
    });

    expect(summary).toMatchObject({
      status: 'failed',
      usage: null,
      tools: [
        {
          callId: 'call-missing',
          name: 'unknown_tool',
          status: 'failed',
          display: { title: 'unknown_tool' },
          completedAt: '2026-09-12T00:00:02.000Z',
        },
      ],
    });
    expect(summary?.tools[0]).not.toHaveProperty('startedAt');
  });

  it('falls back when the resolver returns malformed display data', () => {
    const session = Session.create({ id: sessionId, timestamp: startedAt });
    const input = session.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: 'malformed' }],
    });
    const turn = terminalTurn('turn-malformed-display', input.id, 'completed');
    const summary = buildTurnPresentationSummary({
      turn,
      session,
      toolPresentationResolver: () => ({ title: 42 }) as unknown as { title: string },
      events: [
        event(turn, 0, 'tool_requested', { callId: 'call-malformed', name: 'malformed_tool' }),
        event(turn, 1, 'tool_completed', {
          callId: 'call-malformed',
          name: 'malformed_tool',
          isError: false,
          resultEntryId: 'tool-malformed',
          sessionLeafId: 'tool-malformed',
        }),
      ],
    });

    expect(summary?.tools).toEqual([
      expect.objectContaining({ callId: 'call-malformed', display: { title: 'malformed_tool' } }),
    ]);
  });

  it('supports cancelled and terminal Turns without tools, and skips a terminal Turn without input', () => {
    const session = Session.create({ id: sessionId, timestamp: startedAt });
    const input = session.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: 'cancel' }],
    });
    const cancelled = terminalTurn('turn-cancelled', input.id, 'cancelled');
    const noInput = terminalTurn('turn-no-input', null, 'completed');

    expect(buildTurnPresentationSummary({ turn: cancelled, session, events: [] })).toMatchObject({
      status: 'cancelled',
      inputEntryId: input.id,
      usage: null,
      tools: [],
    });
    expect(buildTurnPresentationSummary({ turn: noInput, session, events: [] })).toBeUndefined();
  });
});

describe('GetSessionHistory turn summary composition', () => {
  it('isolates the active branch and orders summaries by branch input order', () => {
    const session = Session.create({ id: sessionId, timestamp: startedAt });
    const root = session.appendMessage({ role: 'user', content: [{ type: 'text', text: 'root' }] });
    const userA = session.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: 'branch A' }],
    });
    const assistantA = session.appendMessage({
      role: 'assistant',
      api: 'api',
      provider: 'provider',
      model: 'model',
      content: [{ type: 'text', text: 'A' }],
      finishReason: 'stop',
    });
    session.branch(root.id);
    const userB = session.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: 'branch B' }],
    });
    const assistantB = session.appendMessage({
      role: 'assistant',
      api: 'api',
      provider: 'provider',
      model: 'model',
      content: [{ type: 'text', text: 'B' }],
      finishReason: 'stop',
    });
    const userC = session.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: 'branch B second turn' }],
    });
    const assistantC = session.appendMessage({
      role: 'assistant',
      api: 'api',
      provider: 'provider',
      model: 'model',
      content: [{ type: 'text', text: 'C' }],
      finishReason: 'stop',
    });
    const turnA = terminalTurn('turn-a', userA.id, 'completed');
    const turnB = terminalTurn('turn-b', userB.id, 'completed');
    const turnC = terminalTurn('turn-c', userC.id, 'completed');
    const events = new Map<string, TurnEvent[]>([
      [
        'turn-a',
        [
          event(turnA, 0, 'assistant_message_completed', {
            entryId: assistantA.id,
            sessionLeafId: assistantA.id,
          }),
        ],
      ],
      [
        'turn-b',
        [
          event(turnB, 0, 'assistant_message_completed', {
            entryId: assistantB.id,
            sessionLeafId: assistantB.id,
          }),
        ],
      ],
      [
        'turn-c',
        [
          event(turnC, 0, 'assistant_message_completed', {
            entryId: assistantC.id,
            sessionLeafId: assistantC.id,
          }),
        ],
      ],
    ]);
    const sessionStore: SessionStore = {
      create: () => {
        throw new Error('not used');
      },
      load: () => session,
      appendEntry: () => {
        throw new Error('not used');
      },
      saveMetadata: () => {
        throw new Error('not used');
      },
    };
    const turnStore: TurnStore = {
      create: () => {
        throw new Error('not used');
      },
      load: () => {
        throw new Error('not used');
      },
      save: () => {
        throw new Error('not used');
      },
      appendEvent: () => {
        throw new Error('not used');
      },
      loadEvents: (turnId) => events.get(turnId) ?? [],
      listBySession: () => [turnC, turnA, turnB],
      listRecoverable: () => [],
    };

    const result = new GetSessionHistory({ sessionStore, turnStore }).execute(sessionId);

    expect(result.items.map((item) => item.id)).toEqual([
      root.id,
      userB.id,
      assistantB.id,
      userC.id,
      assistantC.id,
    ]);
    expect(result.turnSummaries.map((summary) => summary.turnId)).toEqual(['turn-b', 'turn-c']);
  });
});

function terminalTurn(
  id: string,
  inputEntryId: string | null,
  status: 'completed' | 'failed' | 'cancelled',
): Turn {
  const turn = Turn.create({ id, sessionId, createdAt: startedAt });
  turn.start(startedAt);
  if (inputEntryId !== null) turn.recordInput(inputEntryId);
  if (status === 'completed') turn.complete(null, '2026-09-12T00:00:05.000Z');
  if (status === 'failed') turn.fail('2026-09-12T00:00:05.000Z');
  if (status === 'cancelled') turn.cancel('2026-09-12T00:00:05.000Z');
  return turn;
}

function event(
  turn: Turn,
  sequence: number,
  type: TurnEvent['type'],
  fields: Record<string, unknown> = {},
  attempt = 1,
): TurnEvent {
  return {
    version: 1,
    id: `${turn.getId()}-event-${sequence}-${attempt}`,
    turnId: turn.getId(),
    sessionId: turn.getSessionId(),
    sequence,
    attempt,
    timestamp: new Date(Date.parse(startedAt) + sequence * 1_000).toISOString(),
    type,
    ...fields,
  } as TurnEvent;
}
