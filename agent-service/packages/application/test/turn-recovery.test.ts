import { describe, expect, it } from 'vitest';
import type { AgentToolResult } from '@opspilot/agent-runtime';
import type {
  AssistantMessage,
  Context,
  Model,
  ModelEventStream,
  ModelGateway,
  Options,
} from '@opspilot/model-gateway';
import { createModelEventStream } from '@opspilot/model-gateway';
import { Turn } from '@opspilot/domain';

import {
  ResumeTurn,
  TurnEventRecorder,
  type ToolDefinition,
  type TurnExecutionContext,
  type TurnExecutionContextStore,
} from '../src/index.js';
import { InMemorySessionStore } from './support/in-memory-session-store.js';
import { InMemoryTurnStore } from './support/in-memory-turn-store.js';

const model: Model = {
  provider: 'test-provider',
  id: 'test-model',
  name: 'Test Model',
  api: 'test-api',
  baseUrl: 'https://model.example.test/v1',
  reasoning: false,
  thinkingLevelMap: { off: 'none' },
};

function assistant(text: string): AssistantMessage {
  return {
    role: 'assistant',
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: text === '' ? [] : [{ type: 'text', text }],
    finishReason: 'stop',
  };
}

function stream(message: AssistantMessage): ModelEventStream {
  return createModelEventStream(async (controller) => {
    controller.emit({
      type: 'start',
      model,
      partial: { ...message, content: [], finishReason: 'pending' },
    });
    controller.complete(message);
  });
}

function gateway(response: AssistantMessage): ModelGateway & { readonly calls: number } {
  let calls = 0;
  return {
    getProviders: () => [],
    getModels: () => [model],
    getModel: (provider, id) =>
      provider === model.provider && id === model.id ? model : undefined,
    stream: (_model: Model, _context: Context, _options?: Options) => {
      calls += 1;
      return stream(response);
    },
    complete: async () => response,
    get calls() {
      return calls;
    },
  };
}

class InMemoryExecutionContextStore implements TurnExecutionContextStore {
  private readonly contexts = new Map<string, TurnExecutionContext>();

  public save(turnId: string, context: TurnExecutionContext): void {
    this.contexts.set(turnId, structuredClone(context));
  }

  public load(turnId: string): TurnExecutionContext | null {
    return structuredClone(this.contexts.get(turnId) ?? null);
  }
}

it('resumes a durable assistant tool-call batch without duplicating the assistant message', async () => {
  const sessionStore = new InMemorySessionStore();
  const turnStore = new InMemoryTurnStore();
  const session = sessionStore.create();
  const modelChange = session.appendModelChange(model.provider, model.id);
  sessionStore.appendEntry(session.getId(), modelChange);
  const input = session.appendMessage({
    role: 'user',
    content: [{ type: 'text', text: 'inspect' }],
  });
  sessionStore.appendEntry(session.getId(), input);

  const turn = Turn.create({
    sessionId: session.getId(),
    baseLeafId: modelChange.id,
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  turnStore.create(turn);
  turn.start();
  turnStore.save(turn);
  const recorder = new TurnEventRecorder(turn, turnStore, session);
  recorder.recordTurnStarted();
  recorder.recordInputCommitted(input.id, input.id);

  const call = { callId: 'call-1', name: 'lookup', arguments: {} } as const;
  const assistantWithTool: AssistantMessage = {
    ...assistant(''),
    finishReason: 'tool_calls',
    toolCalls: [call],
  };
  const assistantEntry = session.appendMessage(assistantWithTool);
  sessionStore.appendEntry(session.getId(), assistantEntry);
  recorder.recordModelStarted();
  recorder.recordModelCompleted();
  recorder.recordAssistantMessageCompleted(assistantWithTool);
  recorder.recordToolRequested(call.callId, call.name);

  const tool: ToolDefinition = {
    name: 'lookup',
    description: 'Read a value.',
    parameters: { type: 'object', properties: {} },
    recoveryPolicy: 'retry_safe',
    async execute(): Promise<AgentToolResult> {
      return { content: [{ type: 'text', text: 'value' }] };
    },
  };
  const modelGateway = gateway(assistant('done'));
  const resume = new ResumeTurn({
    sessionStore,
    turnStore,
    turnExecutionContextStore: new InMemoryExecutionContextStore(),
    modelGateway,
    toolDefinitions: [tool],
  });

  const result = await resume.execute(turn.getId());
  const recovered = turnStore.load(turn.getId());
  const messages = sessionStore
    .load(session.getId())
    .getEntries()
    .filter((entry) => entry.type === 'message')
    .map((entry) => entry.message);

  expect(result.kind).toBe('resumed');
  expect(modelGateway.calls).toBe(1);
  expect(recovered.getState().status).toBe('completed');
  expect(recovered.getState().attempt).toBe(2);
  expect(
    messages.filter(
      (message) => message.role === 'assistant' && message.finishReason === 'tool_calls',
    ),
  ).toHaveLength(1);
  expect(messages.filter((message) => message.role === 'tool')).toHaveLength(1);
  expect(turnStore.loadEvents(turn.getId()).map((event) => event.type)).toContain('turn_resumed');
});

it('reconciles a terminal event without incrementing the attempt or calling the model', async () => {
  const sessionStore = new InMemorySessionStore();
  const turnStore = new InMemoryTurnStore();
  const session = sessionStore.create();
  const modelChange = session.appendModelChange(model.provider, model.id);
  sessionStore.appendEntry(session.getId(), modelChange);

  const turn = Turn.create({
    sessionId: session.getId(),
    baseLeafId: modelChange.id,
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  turnStore.create(turn);
  turn.start('2026-01-01T00:00:01.000Z');
  turnStore.save(turn);
  const recorder = new TurnEventRecorder(turn, turnStore, session);
  recorder.recordTurnStarted();
  turnStore.appendEvent(turn.getId(), {
    version: 1,
    id: 'terminal-event',
    turnId: turn.getId(),
    sessionId: session.getId(),
    sequence: 1,
    attempt: 1,
    timestamp: '2026-01-01T00:00:02.000Z',
    type: 'turn_completed',
    resultLeafId: modelChange.id,
  });

  const modelGateway = gateway(assistant('must not be called'));
  const result = await new ResumeTurn({
    sessionStore,
    turnStore,
    modelGateway,
    toolDefinitions: [],
  }).execute(turn.getId());

  expect(result.kind).toBe('reconciled');
  expect(modelGateway.calls).toBe(0);
  expect(turnStore.load(turn.getId()).getState()).toMatchObject({
    status: 'completed',
    attempt: 1,
    resultLeafId: modelChange.id,
  });
  expect(turnStore.loadEvents(turn.getId()).map((event) => event.type)).toEqual([
    'turn_started',
    'turn_completed',
  ]);
});
