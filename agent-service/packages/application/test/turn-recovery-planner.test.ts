import { describe, expect, it } from 'vitest';
import type { AssistantMessage, ModelToolCall, ToolResultMessage } from '@opspilot/model-gateway';
import { Session, Turn, type TurnEvent } from '@opspilot/domain';

import { TurnRecoveryPlanner, type ToolDefinition } from '../src/index.js';
import { InMemoryTurnStore } from './support/in-memory-turn-store.js';

const modelFields = {
  api: 'test-api',
  provider: 'test-provider',
  model: 'test-model',
} as const;

describe('TurnRecoveryPlanner', () => {
  it('catches up an assistant commit and completes without another model call', () => {
    const { session, turn, store, input } = createStartedTurn();
    const assistant = assistantMessage('stop');
    const assistantEntry = session.appendMessage(assistant);

    const events: TurnEvent[] = [
      event(turn, 0, { type: 'turn_started' }),
      event(turn, 1, { type: 'input_committed', entryId: input.id, sessionLeafId: input.id }),
      event(turn, 2, { type: 'model_started' }),
      event(turn, 3, { type: 'model_completed' }),
      event(turn, 4, {
        type: 'assistant_message_completed',
        entryId: assistantEntry.id,
        sessionLeafId: assistantEntry.id,
      }),
    ];
    for (const item of events) store.appendEvent(turn.getId(), item);
    turn.recordInput(input.id);
    turn.recordResultLeaf(input.id);
    turn.advanceCheckpoint({ eventSequence: 1, sessionLeafId: input.id, phase: 'input_committed' });
    store.save(turn);

    const plan = new TurnRecoveryPlanner().plan({
      turn: store.load(turn.getId()),
      events: store.loadEvents(turn.getId()),
      session: Session.restore(session.getMetadata(), session.getHeader(), session.getEntries()),
      toolDefinitions: [],
    });

    expect(plan).toMatchObject({
      kind: 'complete_from_assistant',
      sessionLeafId: assistantEntry.id,
      effectiveCheckpoint: { eventSequence: 4, phase: 'assistant_committed' },
    });
  });

  it('returns only the missing call for a partial multi-tool batch', () => {
    const { session, turn, store, input } = createStartedTurn();
    const calls: readonly ModelToolCall[] = [
      { callId: 'a', name: 'read_a', arguments: {} },
      { callId: 'b', name: 'read_b', arguments: {} },
      { callId: 'c', name: 'read_c', arguments: {} },
    ];
    const assistantEntry = session.appendMessage(assistantMessage('tool_calls', calls));
    const resultA = session.appendMessage(toolMessage('a', 'read_a'));
    const resultB = session.appendMessage(toolMessage('b', 'read_b'));
    const events: TurnEvent[] = [
      event(turn, 0, { type: 'turn_started' }),
      event(turn, 1, { type: 'input_committed', entryId: input.id, sessionLeafId: input.id }),
      event(turn, 2, {
        type: 'assistant_message_completed',
        entryId: assistantEntry.id,
        sessionLeafId: assistantEntry.id,
      }),
      event(turn, 3, {
        type: 'tool_completed',
        callId: 'a',
        name: 'read_a',
        isError: false,
        resultEntryId: resultA.id,
        sessionLeafId: resultA.id,
      }),
      event(turn, 4, {
        type: 'tool_completed',
        callId: 'b',
        name: 'read_b',
        isError: false,
        resultEntryId: resultB.id,
        sessionLeafId: resultB.id,
      }),
    ];
    for (const item of events) store.appendEvent(turn.getId(), item);
    turn.recordInput(input.id);
    turn.recordResultLeaf(input.id);
    turn.advanceCheckpoint({
      eventSequence: 4,
      sessionLeafId: resultB.id,
      phase: 'tool_completed',
    });
    store.save(turn);

    const plan = new TurnRecoveryPlanner().plan({
      turn: store.load(turn.getId()),
      events: store.loadEvents(turn.getId()),
      session: Session.restore(session.getMetadata(), session.getHeader(), session.getEntries()),
      toolDefinitions: [
        toolDefinition('read_a'),
        toolDefinition('read_b'),
        toolDefinition('read_c'),
      ],
    });

    expect(plan.kind).toBe('resume_tools');
    if (plan.kind === 'resume_tools')
      expect(plan.pendingToolCalls.map((call) => call.callId)).toEqual(['c']);
  });

  it('blocks an ambiguous non-retry-safe started tool', () => {
    const { session, turn, store, input } = createStartedTurn();
    const call = { callId: 'side-effect', name: 'send_email', arguments: {} };
    const assistantEntry = session.appendMessage(assistantMessage('tool_calls', [call]));
    const events: TurnEvent[] = [
      event(turn, 0, { type: 'turn_started' }),
      event(turn, 1, { type: 'input_committed', entryId: input.id, sessionLeafId: input.id }),
      event(turn, 2, {
        type: 'assistant_message_completed',
        entryId: assistantEntry.id,
        sessionLeafId: assistantEntry.id,
      }),
      event(turn, 3, { type: 'tool_started', callId: call.callId, name: call.name }),
    ];
    for (const item of events) store.appendEvent(turn.getId(), item);
    turn.recordInput(input.id);
    turn.recordResultLeaf(input.id);
    turn.advanceCheckpoint({
      eventSequence: 2,
      sessionLeafId: assistantEntry.id,
      phase: 'assistant_committed',
    });
    store.save(turn);

    const plan = new TurnRecoveryPlanner().plan({
      turn: store.load(turn.getId()),
      events: store.loadEvents(turn.getId()),
      session: Session.restore(session.getMetadata(), session.getHeader(), session.getEntries()),
      toolDefinitions: [toolDefinition('send_email')],
    });

    expect(plan).toMatchObject({ kind: 'blocked', callIds: ['side-effect'] });
  });
});

function createStartedTurn(): {
  session: Session;
  turn: Turn;
  store: InMemoryTurnStore;
  input: ReturnType<Session['appendMessage']>;
} {
  const session = Session.create({ id: `session-${Math.random().toString(36).slice(2)}` });
  const input = session.appendMessage({ role: 'user', content: [{ type: 'text', text: 'input' }] });
  const turn = Turn.create({
    id: `turn-${Math.random().toString(36).slice(2)}`,
    sessionId: session.getId(),
  });
  turn.start();
  const store = new InMemoryTurnStore();
  store.create(turn);
  return { session, turn, store, input };
}

function assistantMessage(
  finishReason: AssistantMessage['finishReason'],
  toolCalls?: readonly ModelToolCall[],
): AssistantMessage {
  return {
    role: 'assistant',
    ...modelFields,
    content: [],
    finishReason,
    ...(toolCalls === undefined ? {} : { toolCalls }),
  };
}

function toolMessage(callId: string, name: string): ToolResultMessage {
  return { role: 'tool', callId, name, content: [{ type: 'text', text: 'ok' }], isError: false };
}

function event(turn: Turn, sequence: number, payload: object): TurnEvent {
  return {
    version: 1,
    id: `event-${sequence}`,
    turnId: turn.getId(),
    sessionId: turn.getSessionId(),
    sequence,
    attempt: turn.getState().attempt,
    timestamp: new Date().toISOString(),
    ...payload,
  } as TurnEvent;
}

function toolDefinition(name: string): ToolDefinition {
  return {
    name,
    description: name,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
  };
}
