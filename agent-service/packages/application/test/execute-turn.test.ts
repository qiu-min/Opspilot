import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage, AgentToolResult } from '@opspilot/agent-runtime';
import type {
  AssistantMessage,
  Context,
  ModelToolCall,
  Options,
  Model,
  ModelEventStream,
  ModelGateway,
} from '@opspilot/model-gateway';
import { createModelEventStream } from '@opspilot/model-gateway';

import {
  AgentSession,
  buildSessionContext,
  createCompactionSummaryMessage,
  type ContextManager,
  ExecuteTurn,
  type ExecuteTurnDependencies,
  type TurnExecutionEvent,
  type TurnStreamHub,
  type TurnStore,
  Session,
  type SessionStore,
  type ToolContext,
  type ToolDefinition,
} from '../src/index.js';
import { InMemorySessionStore } from './support/in-memory-session-store.js';
import { InMemoryTurnStore } from './support/in-memory-turn-store.js';

class TestExecuteTurn extends ExecuteTurn {
  public constructor(
    options: Omit<ExecuteTurnDependencies, 'turnStore'> & {
      readonly turnStore?: ExecuteTurnDependencies['turnStore'];
    },
  ) {
    super({ ...options, turnStore: options.turnStore ?? new InMemoryTurnStore() });
  }
}

type TestTurnExecutionEvent = TurnExecutionEvent;

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

const model: Model = {
  provider: 'test-provider',
  id: 'test-model',
  name: 'Test Model',
  api: 'test-api',
  baseUrl: 'https://model.example.test/v1',
  reasoning: true,
  reasoningProtocol: 'openai-reasoning-effort',
  thinkingLevelMap: {
    off: 'none',
    minimal: 'low',
    low: 'low',
    medium: 'medium',
    high: 'high',
  },
};

const alternateModel: Model = {
  ...model,
  provider: 'alternate-provider',
  id: 'alternate-model',
  name: 'Alternate Model',
};

const lowOnlyModel: Model = {
  ...model,
  id: 'low-only-model',
  thinkingLevelMap: { low: 'low' },
};

afterEach(() => {
  vi.restoreAllMocks();
});

function createStore(): { store: InMemorySessionStore; turnStore: InMemoryTurnStore } {
  return { store: new InMemorySessionStore(), turnStore: new InMemoryTurnStore() };
}

function appendPersisted<T extends Parameters<SessionStore['appendEntry']>[1]>(
  store: SessionStore,
  session: Session,
  append: () => T,
): T {
  const entry = append();
  store.appendEntry(session.getHeader().id, entry);
  return entry;
}

function userMessage(text: string): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text }] };
}

function assistantMessage(
  text: string,
  responseModel: Model = model,
  toolCalls?: readonly ModelToolCall[],
): AssistantMessage {
  return {
    role: 'assistant',
    api: responseModel.api,
    provider: responseModel.provider,
    model: responseModel.id,
    content: text === '' ? [] : [{ type: 'text', text }],
    finishReason: toolCalls === undefined ? 'stop' : 'tool_calls',
    ...(toolCalls === undefined ? {} : { toolCalls }),
  };
}

function assistantStream(message: AgentMessage, streamModel: Model): ModelEventStream {
  if (message.role !== 'assistant') throw new Error('Expected an assistant message.');

  return createModelEventStream(async (controller) => {
    controller.emit({
      type: 'start',
      model: streamModel,
      partial: { ...message, content: [], finishReason: 'pending' },
    });
    controller.complete(message);
  });
}

function failedAssistantStream(message: AssistantMessage, streamModel: Model): ModelEventStream {
  return createModelEventStream(async (controller) => {
    controller.emit({
      type: 'start',
      model: streamModel,
      partial: { ...message, content: [], finishReason: 'pending' },
    });
    controller.error(message);
  });
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function waitingAssistantStream(
  message: AgentMessage,
  streamModel: Model,
  started: Deferred<void>,
  release: Deferred<void>,
): ModelEventStream {
  if (message.role !== 'assistant') throw new Error('Expected an assistant message.');

  return createModelEventStream(async (controller) => {
    controller.emit({
      type: 'start',
      model: streamModel,
      partial: { ...message, content: [], finishReason: 'pending' },
    });
    started.resolve(undefined);
    await release.promise;
    controller.complete(message);
  });
}

function createGateway(
  streams: readonly ModelEventStream[],
  registeredModels: readonly Model[] = [model],
  onStream?: () => void,
  completion?: AssistantMessage,
): ModelGateway & {
  readonly requestedModels: Model[];
  readonly requestedContexts: Context[];
  readonly requestedOptions: (Options | undefined)[];
  readonly stream: ReturnType<typeof vi.fn>;
  readonly complete: ReturnType<typeof vi.fn>;
} {
  let streamIndex = 0;
  const requestedModels: Model[] = [];
  const requestedContexts: Context[] = [];
  const requestedOptions: (Options | undefined)[] = [];
  const stream = vi.fn((requestedModel: Model, context: Context, options?: Options) => {
    requestedModels.push(requestedModel);
    requestedContexts.push(context);
    requestedOptions.push(options);
    onStream?.();
    const next = streams[streamIndex++];
    if (next === undefined) throw new Error('Unexpected extra model call.');
    return next;
  });
  const complete = vi.fn(async (_model: Model, _context: Context, _options?: Options) => {
    if (completion === undefined) throw new Error('complete is not used by this test.');
    return completion;
  });

  return {
    getProviders: () => [],
    getModels: () => registeredModels,
    getModel: (provider, id) =>
      registeredModels.find((candidate) => candidate.provider === provider && candidate.id === id),
    stream,
    complete,
    requestedModels,
    requestedContexts,
    requestedOptions,
  };
}

function messageEntries(session: Session): AgentMessage[] {
  return session
    .getEntries()
    .filter((entry) => entry.type === 'message')
    .map((entry) => entry.message);
}

describe('ExecuteTurn', () => {
  it('propagates the configured system prompt to the model context', async () => {
    const { store } = createStore();
    const gateway = createGateway([assistantStream(assistantMessage('world'), model)]);
    const runner = new TestExecuteTurn({
      sessionStore: store,
      modelGateway: gateway,
      toolDefinitions: [],
      defaultModel: model,
      systemPrompt: 'SENTINEL_SYSTEM_PROMPT',
    });

    await runner.execute({ message: userMessage('hello') });

    expect(gateway.requestedContexts[0]?.systemPrompt).toBe('SENTINEL_SYSTEM_PROMPT');
  });

  it('keeps the original behavior when onEvent is omitted', async () => {
    const { store } = createStore();
    const inputMessage = userMessage('hello');
    const response = assistantMessage('world');
    const gateway = createGateway([assistantStream(response, model)]);
    const runner = new TestExecuteTurn({
      sessionStore: store,
      modelGateway: gateway,
      toolDefinitions: [],
      defaultModel: model,
    });

    const result = await runner.execute({ message: inputMessage });
    const loaded = store.load(result.sessionId);

    expect(result.sessionId).toBe(loaded.getHeader().id);
    expect(result.leafId).toBe(loaded.getLeafId());
    expect(result.messages).toEqual([inputMessage, response]);
    expect(messageEntries(loaded)).toEqual([inputMessage, response]);
  });

  it('persists a completed Turn with ordered events and an assistant checkpoint', async () => {
    const { store, turnStore } = createStore();
    const runner = new TestExecuteTurn({
      sessionStore: store,
      turnStore,
      modelGateway: createGateway([assistantStream(assistantMessage('done'), model)]),
      toolDefinitions: [],
      defaultModel: model,
    });

    const input = userMessage('hello');
    const result = await runner.execute({ message: input });
    const events = turnStore.loadEvents(result.turnId);
    const turn = turnStore.load(result.turnId);
    const session = store.load(result.sessionId);

    expect(
      session
        .getEntries()
        .filter((entry) => entry.type === 'message')
        .map((entry) => entry.message),
    ).toEqual([input, assistantMessage('done')]);
    expect(events.map((event) => event.type)).toEqual([
      'turn_started',
      'input_committed',
      'model_started',
      'model_completed',
      'assistant_message_completed',
      'turn_completed',
    ]);
    expect(events.map((event) => event.sequence)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(turn.getState()).toMatchObject({ status: 'completed', attempt: 1 });
    expect(turn.getState().checkpoint).toMatchObject({
      eventSequence: 4,
      phase: 'assistant_committed',
      sessionLeafId: session.getLeafId(),
    });
  });

  it('persists the input SessionEntry before its TurnEvent and checkpoint snapshot', async () => {
    const baseSessionStore = new InMemorySessionStore();
    const baseTurnStore = new InMemoryTurnStore();
    const operations: string[] = [];
    const sessionStore: SessionStore = {
      create: () => baseSessionStore.create(),
      load: (sessionId) => baseSessionStore.load(sessionId),
      appendEntry: (sessionId, entry) => {
        operations.push('session.appendEntry');
        baseSessionStore.appendEntry(sessionId, entry);
      },
      saveMetadata: (sessionId, metadata) => baseSessionStore.saveMetadata(sessionId, metadata),
    };
    const turnStore: TurnStore = {
      create: (turn) => baseTurnStore.create(turn),
      load: (turnId) => baseTurnStore.load(turnId),
      save: (turn) => {
        const phase = turn.getState().checkpoint?.phase ?? 'none';
        operations.push(`turn.save:${phase}`);
        baseTurnStore.save(turn);
      },
      appendEvent: (turnId, event) => {
        operations.push(`turn.appendEvent:${event.type}`);
        baseTurnStore.appendEvent(turnId, event);
      },
      loadEvents: (turnId) => baseTurnStore.loadEvents(turnId),
      listBySession: (sessionId) => baseTurnStore.listBySession(sessionId),
      listRecoverable: () => baseTurnStore.listRecoverable(),
    };
    const runner = new TestExecuteTurn({
      sessionStore,
      turnStore,
      modelGateway: createGateway([assistantStream(assistantMessage('done'), model)]),
      toolDefinitions: [],
      defaultModel: model,
    });

    await runner.execute({ message: userMessage('hello') });

    const inputAppendIndex = operations.indexOf('session.appendEntry');
    const inputEventIndex = operations.indexOf('turn.appendEvent:input_committed');
    const inputCheckpointSaveIndex = operations.indexOf('turn.save:input_committed');
    expect(inputAppendIndex).toBeGreaterThanOrEqual(0);
    expect(inputEventIndex).toBeGreaterThan(inputAppendIndex);
    expect(inputCheckpointSaveIndex).toBeGreaterThan(inputEventIndex);
  });

  it('persists initial model and thinking configuration before the input checkpoint', async () => {
    const { store, turnStore } = createStore();
    const runner = new TestExecuteTurn({
      sessionStore: store,
      turnStore,
      modelGateway: createGateway([assistantStream(assistantMessage('done'), model)]),
      toolDefinitions: [],
      defaultModel: model,
    });

    const result = await runner.execute({ message: userMessage('hello'), thinkingLevel: 'high' });
    const session = store.load(result.sessionId);
    const entries = session.getEntries();
    const inputEntry = entries.find(
      (entry) => entry.type === 'message' && entry.message.role === 'user',
    );
    const events = turnStore.loadEvents(result.turnId);
    const inputEvent = events.find((event) => event.type === 'input_committed');
    const modelStartedEvent = events.find((event) => event.type === 'model_started');

    expect(entries.slice(0, 3).map((entry) => entry.type)).toEqual([
      'model_change',
      'thinking_level_change',
      'message',
    ]);
    expect(inputEntry).toBeDefined();
    expect(inputEvent).toMatchObject({ sessionLeafId: inputEntry?.id });
    expect(modelStartedEvent?.sequence).toBeGreaterThan(inputEvent?.sequence ?? -1);
  });

  it('persists an explicit model override before the input checkpoint', async () => {
    const { store, turnStore } = createStore();
    const gateway = createGateway(
      [assistantStream(assistantMessage('done', alternateModel), alternateModel)],
      [model, alternateModel],
    );
    const runner = new TestExecuteTurn({
      sessionStore: store,
      turnStore,
      modelGateway: gateway,
      toolDefinitions: [],
      defaultModel: model,
    });

    const result = await runner.execute({ message: userMessage('hello'), model: alternateModel });
    const session = store.load(result.sessionId);
    const entries = session.getEntries();
    const modelEntry = entries.find((entry) => entry.type === 'model_change');
    const inputEntry = entries.find(
      (entry) => entry.type === 'message' && entry.message.role === 'user',
    );

    expect(modelEntry).toMatchObject({
      provider: alternateModel.provider,
      modelId: alternateModel.id,
    });
    expect(entries.indexOf(modelEntry!)).toBeLessThan(entries.indexOf(inputEntry!));
  });

  it('persists a clamped thinking override before the input checkpoint', async () => {
    const { store, turnStore } = createStore();
    const runner = new TestExecuteTurn({
      sessionStore: store,
      turnStore,
      modelGateway: createGateway(
        [assistantStream(assistantMessage('done', lowOnlyModel), lowOnlyModel)],
        [lowOnlyModel],
      ),
      toolDefinitions: [],
      defaultModel: lowOnlyModel,
    });

    const result = await runner.execute({ message: userMessage('hello'), thinkingLevel: 'high' });
    const entries = store.load(result.sessionId).getEntries();
    const inputIndex = entries.findIndex(
      (entry) => entry.type === 'message' && entry.message.role === 'user',
    );

    expect(entries.slice(0, inputIndex).map((entry) => entry.type)).toEqual([
      'model_change',
      'thinking_level_change',
    ]);
    expect(entries[1]).toMatchObject({ type: 'thinking_level_change', thinkingLevel: 'low' });
  });

  it('persists an existing Session model override before the next input', async () => {
    const { store, turnStore } = createStore();
    const existing = store.create();
    appendPersisted(store, existing, () => existing.appendModelChange(model.provider, model.id));
    const gateway = createGateway(
      [assistantStream(assistantMessage('done', alternateModel), alternateModel)],
      [model, alternateModel],
    );
    const runner = new TestExecuteTurn({
      sessionStore: store,
      turnStore,
      modelGateway: gateway,
      toolDefinitions: [],
      defaultModel: model,
    });

    const result = await runner.execute({
      sessionId: existing.getId(),
      message: userMessage('switch model'),
      model: alternateModel,
    });
    const session = store.load(result.sessionId);
    const entries = session.getEntries();
    const inputIndex = entries.findIndex(
      (entry) => entry.type === 'message' && entry.message.role === 'user',
    );
    const overrideIndex = entries.findIndex(
      (entry) =>
        entry.type === 'model_change' &&
        entry.provider === alternateModel.provider &&
        entry.modelId === alternateModel.id,
    );

    expect(overrideIndex).toBeGreaterThan(-1);
    expect(overrideIndex).toBeLessThan(inputIndex);
  });

  it('records tool lifecycle facts only after the ToolResult is durable', async () => {
    const { store, turnStore } = createStore();
    const call: ModelToolCall = { callId: 'call-1', name: 'lookup', arguments: {} };
    const runner = new TestExecuteTurn({
      sessionStore: store,
      turnStore,
      modelGateway: createGateway([
        assistantStream(assistantMessage('', model, [call]), model),
        assistantStream(assistantMessage('done'), model),
      ]),
      toolDefinitions: [
        {
          name: 'lookup',
          description: 'Lookup',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
          execute: async () => ({ content: [{ type: 'text', text: 'result' }] }),
        },
      ],
      defaultModel: model,
    });

    const result = await runner.execute({ message: userMessage('use tool') });
    const events = turnStore.loadEvents(result.turnId);
    const toolEventIndex = events.findIndex((event) => event.type === 'tool_completed');
    const session = store.load(result.sessionId);
    const toolEntry = session
      .getEntries()
      .find((entry) => entry.type === 'message' && entry.message.role === 'tool');

    expect(events.map((event) => event.type)).toEqual([
      'turn_started',
      'input_committed',
      'model_started',
      'model_completed',
      'assistant_message_completed',
      'tool_requested',
      'tool_started',
      'tool_completed',
      'model_started',
      'model_completed',
      'assistant_message_completed',
      'turn_completed',
    ]);
    expect(toolEntry?.type).toBe('message');
    expect(events[toolEventIndex]).toMatchObject({
      type: 'tool_completed',
      resultEntryId: toolEntry?.id,
      sessionLeafId: toolEntry?.id,
    });
    expect(turnStore.load(result.turnId).getState().checkpoint).toMatchObject({
      phase: 'assistant_committed',
      sessionLeafId: session.getLeafId(),
    });
  });

  it('leaves a failed Turn and durable history when Runtime execution fails', async () => {
    const { store, turnStore } = createStore();
    const failedResponse: AssistantMessage = {
      ...assistantMessage('', model),
      finishReason: 'error',
      errorMessage: 'provider failed',
    };
    const runner = new TestExecuteTurn({
      sessionStore: store,
      turnStore,
      modelGateway: createGateway([failedAssistantStream(failedResponse, model)]),
      toolDefinitions: [],
      defaultModel: model,
    });

    const result = await runner.execute({ message: userMessage('hello') });
    const turn = turnStore.load(result.turnId);
    const events = turnStore.loadEvents(result.turnId);

    expect(turn.getState().status).toBe('failed');
    expect(events.at(-1)).toMatchObject({ type: 'turn_failed', message: 'provider failed' });
    expect(messageEntries(store.load(result.sessionId))).toHaveLength(2);
  });

  it('closes an unconfirmed live channel when durable failure recording also fails', async () => {
    const { store, turnStore: baseTurnStore } = createStore();
    const turnStore: TurnStore = {
      create: (turn) => baseTurnStore.create(turn),
      load: (turnId) => baseTurnStore.load(turnId),
      save: (turn) => baseTurnStore.save(turn),
      appendEvent: (turnId, event) => {
        if (event.type === 'turn_failed') throw new Error('failure persistence unavailable');
        baseTurnStore.appendEvent(turnId, event);
      },
      loadEvents: (turnId) => baseTurnStore.loadEvents(turnId),
      listBySession: (sessionId) => baseTurnStore.listBySession(sessionId),
      listRecoverable: () => baseTurnStore.listRecoverable(),
    };
    const closeTurn = vi.fn();
    const publish = vi.fn();
    const streamHub = {
      openTurn: vi.fn(),
      publish,
      publishDraft: publish,
      getActiveTurn: vi.fn(),
      getProjection: vi.fn(),
      subscribe: vi.fn(),
      closeTurn,
    } as unknown as TurnStreamHub;
    const runner = new TestExecuteTurn({
      sessionStore: store,
      turnStore,
      modelGateway: createGateway([]),
      toolDefinitions: [],
      defaultModel: model,
      turnStreamHub: streamHub,
    });

    await expect(
      runner.execute(
        { message: userMessage('hello') },
        {
          onEvent: (event) => {
            if (event.type === 'turn_ready') throw new Error('observer failed');
          },
        },
      ),
    ).rejects.toThrow('observer failed');

    expect(closeTurn).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledOnce();
    const startedEvent = publish.mock.calls[0]?.[0] as { readonly turnId: string };
    expect(baseTurnStore.load(startedEvent.turnId).getState().status).toBe('running');
  });

  it('awaits session_ready listeners before creating AgentSession', async () => {
    const { store } = createStore();
    const gateway = createGateway([assistantStream(assistantMessage('done'), model)]);
    const runner = new TestExecuteTurn({
      sessionStore: store,
      modelGateway: gateway,
      toolDefinitions: [],
      defaultModel: model,
    });
    const listenerStarted = createDeferred<void>();
    const releaseListener = createDeferred<void>();

    const execution = runner.execute(
      { message: userMessage('hello') },
      {
        onEvent: async (event) => {
          if (event.type !== 'session_ready') return;
          listenerStarted.resolve(undefined);
          await releaseListener.promise;
        },
      },
    );

    await listenerStarted.promise;
    expect(gateway.stream).not.toHaveBeenCalled();

    releaseListener.resolve(undefined);
    await execution;
    expect(gateway.stream).toHaveBeenCalledOnce();
  });

  it('does not emit session_ready when session creation fails', async () => {
    const events: TestTurnExecutionEvent[] = [];
    const creationError = new Error('session creation failed');
    const sessionStore: SessionStore = {
      create: () => {
        throw creationError;
      },
      load: () => {
        throw new Error('load should not be called');
      },
      appendEntry: () => {
        throw new Error('append should not be called');
      },
      saveMetadata: () => {
        throw new Error('metadata should not be saved');
      },
    };
    const runner = new TestExecuteTurn({
      sessionStore,
      modelGateway: createGateway([]),
      toolDefinitions: [],
      defaultModel: model,
    });

    await expect(
      runner.execute(
        { message: userMessage('hello') },
        {
          onEvent: (event) => {
            events.push(event);
          },
        },
      ),
    ).rejects.toThrow('session creation failed');
    expect(events).toEqual([]);
  });

  it('propagates session_ready listener failures before starting AgentSession', async () => {
    const { store } = createStore();
    const gateway = createGateway([]);
    const runner = new TestExecuteTurn({
      sessionStore: store,
      modelGateway: gateway,
      toolDefinitions: [],
      defaultModel: model,
    });
    const listenerError = new Error('session_ready listener failed');

    await expect(
      runner.execute(
        { message: userMessage('hello') },
        {
          onEvent: (event) => {
            if (event.type === 'session_ready') throw listenerError;
          },
        },
      ),
    ).rejects.toThrow('session_ready listener failed');
    expect(gateway.stream).not.toHaveBeenCalled();
  });

  it('loads an existing session, restores history, and appends the next turn once', async () => {
    const { store } = createStore();
    const firstInput = userMessage('first');
    const firstResponse = assistantMessage('first response');
    const firstRunner = new TestExecuteTurn({
      sessionStore: store,
      modelGateway: createGateway([assistantStream(firstResponse, model)]),
      toolDefinitions: [],
      defaultModel: model,
    });
    const firstResult = await firstRunner.execute({ message: firstInput });

    const secondInput = userMessage('second');
    const secondResponse = assistantMessage('second response');
    const secondGateway = createGateway([assistantStream(secondResponse, model)]);
    const secondRunner = new TestExecuteTurn({
      sessionStore: store,
      modelGateway: secondGateway,
      toolDefinitions: [],
      defaultModel: model,
    });
    const events: TestTurnExecutionEvent[] = [];

    const secondResult = await secondRunner.execute(
      {
        sessionId: firstResult.sessionId,
        message: secondInput,
      },
      {
        onEvent: (event) => {
          events.push(event);
        },
      },
    );
    const loaded = store.load(firstResult.sessionId);

    expect(events[0]).toEqual({
      type: 'session_ready',
      sessionId: firstResult.sessionId,
      created: false,
    });
    expect(secondResult.messages).toEqual([secondInput, secondResponse]);
    expect(messageEntries(loaded)).toEqual([
      firstInput,
      firstResponse,
      secondInput,
      secondResponse,
    ]);
    expect(secondGateway.requestedModels[0]).toBe(model);
  });

  it('auto-compacts after a run and uses the summary on the next turn', async () => {
    const { store } = createStore();
    const compactingModel = { ...model, contextWindow: 80 };
    const firstInput = userMessage('first input');
    const firstResponse = {
      ...assistantMessage('first response', compactingModel),
      usage: { inputTokens: 90, outputTokens: 10, totalTokens: 100 },
    };
    const secondInput = userMessage('second input');
    const secondResponse = assistantMessage('second response', compactingModel);
    const summaryResponse = assistantMessage('history summary', compactingModel);
    const gateway = createGateway(
      [
        assistantStream(firstResponse, compactingModel),
        assistantStream(secondResponse, compactingModel),
      ],
      [compactingModel],
      undefined,
      summaryResponse,
    );
    const runner = new TestExecuteTurn({
      sessionStore: store,
      modelGateway: gateway,
      toolDefinitions: [],
      defaultModel: compactingModel,
      compactionSettings: {
        enabled: true,
        reserveTokens: 0,
        keepRecentTokens: 1,
      },
    });

    const firstResult = await runner.execute({ message: firstInput });
    const afterCompaction = store.load(firstResult.sessionId);
    const compaction = afterCompaction.getEntries().find((entry) => entry.type === 'compaction');

    expect(compaction).toEqual(
      expect.objectContaining({
        type: 'compaction',
        summary: 'history summary',
      }),
    );

    await runner.execute({ sessionId: firstResult.sessionId, message: secondInput });

    expect(gateway.requestedContexts[1]?.messages).toEqual([
      createCompactionSummaryMessage('history summary'),
      firstResponse,
      secondInput,
    ]);
    expect(gateway.complete).toHaveBeenCalledOnce();
    expect(
      store
        .load(firstResult.sessionId)
        .getEntries()
        .filter((entry) => entry.type === 'message')
        .map((entry) => entry.message),
    ).toEqual([firstInput, firstResponse, secondInput, secondResponse]);
  });

  it('compacts before a prompt, refreshes runtime history, and keeps the summary out of Session messages', async () => {
    const { store } = createStore();
    const compactingModel = { ...model, contextWindow: 40 };
    const existing = store.create();
    const oldInput = userMessage('O');
    const oldResponse = {
      ...assistantMessage('R', compactingModel),
      usage: { inputTokens: 90, outputTokens: 10, totalTokens: 100 },
    };
    appendPersisted(store, existing, () =>
      existing.appendModelChange(compactingModel.provider, compactingModel.id),
    );
    appendPersisted(store, existing, () => existing.appendMessage(oldInput));
    appendPersisted(store, existing, () => existing.appendMessage(oldResponse));

    const newInput = userMessage('N');
    const response = assistantMessage('D', compactingModel);
    const summaryResponse = assistantMessage('S', compactingModel);
    const gateway = createGateway(
      [assistantStream(response, compactingModel)],
      [compactingModel],
      undefined,
      summaryResponse,
    );
    const runner = new TestExecuteTurn({
      sessionStore: store,
      modelGateway: gateway,
      toolDefinitions: [],
      compactionSettings: {
        enabled: true,
        reserveTokens: 0,
        keepRecentTokens: 1,
      },
    });

    await runner.execute({ sessionId: existing.getHeader().id, message: newInput });

    expect(gateway.complete).toHaveBeenCalledOnce();
    expect(gateway.requestedContexts[0]?.messages).toEqual([
      createCompactionSummaryMessage('S'),
      newInput,
    ]);

    const loaded = store.load(existing.getHeader().id);
    expect(loaded.getEntries().filter((entry) => entry.type === 'compaction')).toHaveLength(1);
    expect(messageEntries(loaded)).toEqual([oldInput, oldResponse, newInput, response]);
    expect(buildSessionContext(loaded).messages).toEqual([
      createCompactionSummaryMessage('S'),
      newInput,
      response,
    ]);
  });

  it('pre-prompt compacts history left oversized by an aborted previous run', async () => {
    const { store } = createStore();
    const compactingModel = { ...model, contextWindow: 120 };
    const existing = store.create();
    const oldInput = userMessage('old input');
    const oldResponse = {
      ...assistantMessage('R', compactingModel),
      usage: { inputTokens: 90, outputTokens: 10, totalTokens: 100 },
    };
    appendPersisted(store, existing, () =>
      existing.appendModelChange(compactingModel.provider, compactingModel.id),
    );
    appendPersisted(store, existing, () => existing.appendMessage(oldInput));
    appendPersisted(store, existing, () => existing.appendMessage(oldResponse));

    const oversizedInput = userMessage('x'.repeat(200));
    const abortedResponse: AssistantMessage = {
      ...assistantMessage('', compactingModel),
      finishReason: 'aborted',
      errorMessage: 'Request aborted.',
    };
    const firstRunner = new TestExecuteTurn({
      sessionStore: store,
      modelGateway: createGateway(
        [failedAssistantStream(abortedResponse, compactingModel)],
        [compactingModel],
      ),
      toolDefinitions: [],
      compactionSettings: {
        enabled: true,
        reserveTokens: 0,
        keepRecentTokens: 1,
      },
    });

    await firstRunner.execute({
      sessionId: existing.getHeader().id,
      message: oversizedInput,
    });

    const nextInput = userMessage('next input');
    const nextResponse = assistantMessage('next response', compactingModel);
    const summaryResponse = assistantMessage('recovered summary', compactingModel);
    const secondGateway = createGateway(
      [assistantStream(nextResponse, compactingModel)],
      [compactingModel],
      undefined,
      summaryResponse,
    );
    const secondRunner = new TestExecuteTurn({
      sessionStore: store,
      modelGateway: secondGateway,
      toolDefinitions: [],
      compactionSettings: {
        enabled: true,
        reserveTokens: 0,
        keepRecentTokens: 1,
      },
    });

    await secondRunner.execute({ sessionId: existing.getHeader().id, message: nextInput });

    expect(secondGateway.complete).toHaveBeenCalledOnce();
    expect(secondGateway.requestedContexts[0]?.messages).toEqual([
      createCompactionSummaryMessage('recovered summary'),
      nextInput,
    ]);
  });

  it('keeps a successful turn successful when post-run compaction fails', async () => {
    const { store } = createStore();
    const compactingModel = { ...model, contextWindow: 1 };
    const inputMessage = userMessage('input');
    const response = assistantMessage('response', compactingModel);
    const gateway = createGateway([assistantStream(response, compactingModel)], [compactingModel]);
    const runner = new TestExecuteTurn({
      sessionStore: store,
      modelGateway: gateway,
      toolDefinitions: [],
      defaultModel: compactingModel,
      compactionSettings: {
        enabled: true,
        reserveTokens: 0,
        keepRecentTokens: 1,
      },
    });

    const result = await runner.execute({ message: inputMessage });
    const loaded = store.load(result.sessionId);

    expect(result.messages).toEqual([inputMessage, response]);
    expect(loaded.getEntries().some((entry) => entry.type === 'compaction')).toBe(false);
    expect(
      loaded
        .getEntries()
        .filter((entry) => entry.type === 'message')
        .map((entry) => entry.message),
    ).toEqual([inputMessage, response]);
  });

  it('uses the prepared context without changing session history or message persistence', async () => {
    const { store } = createStore();
    const firstInput = userMessage('A');
    const firstResponse = assistantMessage('B');
    const firstRunner = new TestExecuteTurn({
      sessionStore: store,
      modelGateway: createGateway([assistantStream(firstResponse, model)]),
      toolDefinitions: [],
      defaultModel: model,
    });
    const firstResult = await firstRunner.execute({ message: firstInput });

    const secondInput = userMessage('C');
    const secondResponse = assistantMessage('D');
    const preparedInputs: AgentMessage[][] = [];
    const contextManager: ContextManager = {
      prepare: async (input) => {
        preparedInputs.push([...input.messages]);
        return { messages: input.messages.slice(-1) };
      },
    };
    const secondGateway = createGateway([assistantStream(secondResponse, model)]);
    const secondRunner = new TestExecuteTurn({
      sessionStore: store,
      modelGateway: secondGateway,
      toolDefinitions: [],
      contextManager,
    });

    const secondResult = await secondRunner.execute({
      sessionId: firstResult.sessionId,
      message: secondInput,
    });
    const loaded = store.load(firstResult.sessionId);

    expect(preparedInputs).toEqual([[firstInput, firstResponse, secondInput]]);
    expect(secondGateway.requestedContexts[0]?.messages).toEqual([secondInput]);
    expect(secondResult.messages).toEqual([secondInput, secondResponse]);
    expect(messageEntries(loaded)).toEqual([
      firstInput,
      firstResponse,
      secondInput,
      secondResponse,
    ]);
  });

  it('wraps ToolDefinitions with the current session context for runtime execution', async () => {
    const { store } = createStore();
    const call: ModelToolCall = {
      callId: 'call-1',
      name: 'lookup',
      arguments: { query: 'value' },
    };
    const toolResult: AgentToolResult<{ source: string }> = {
      content: [{ type: 'text', text: 'tool result' }],
      details: { source: 'fake' },
    };
    let receivedContext: ToolContext | undefined;
    let receivedSignal: AbortSignal | undefined;
    const definition: ToolDefinition<{ source: string }> = {
      name: 'lookup',
      description: 'Lookup description',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
        additionalProperties: false,
      },
      execute: async (_callId, _args, signal, context) => {
        receivedSignal = signal;
        receivedContext = context;
        return toolResult;
      },
    };
    const finalResponse = assistantMessage('done');
    const gateway = createGateway([
      assistantStream(assistantMessage('', model, [call]), model),
      assistantStream(finalResponse, model),
    ]);
    const runner = new TestExecuteTurn({
      sessionStore: store,
      modelGateway: gateway,
      toolDefinitions: [definition],
      defaultModel: model,
    });
    const events: TestTurnExecutionEvent[] = [];

    const result = await runner.execute(
      {
        message: userMessage('use lookup'),
        excelResource: { id: 'resource-1', filePath: 'workbook.xlsx' },
      },
      {
        onEvent: (event) => {
          events.push(event);
        },
      },
    );

    expect(receivedContext).toEqual({
      sessionId: result.sessionId,
      excelResource: { id: 'resource-1', filePath: 'workbook.xlsx' },
    });
    expect(receivedSignal).toBe(gateway.requestedOptions[0]?.signal);
    expect(result.messages[2]).toEqual({
      role: 'tool',
      callId: call.callId,
      name: call.name,
      content: toolResult.content,
      details: toolResult.details,
      isError: false,
    });
    expect(
      events
        .filter(
          (event): event is Extract<TestTurnExecutionEvent, { type: 'tool_execution_start' }> =>
            event.type === 'tool_execution_start',
        )
        .map((event) => event.toolCall.callId),
    ).toEqual([call.callId]);
    expect(
      events
        .filter(
          (event): event is Extract<TestTurnExecutionEvent, { type: 'tool_execution_end' }> =>
            event.type === 'tool_execution_end',
        )
        .map((event) => event.toolCall.callId),
    ).toEqual([call.callId]);
  });

  it('runs an ordinary ToolDefinition without an ExcelResource', async () => {
    const { store } = createStore();
    const call: ModelToolCall = {
      callId: 'call-without-resource',
      name: 'lookup',
      arguments: {},
    };
    let receivedContext: ToolContext | undefined;
    const definition: ToolDefinition = {
      name: 'lookup',
      description: 'Lookup description',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async (_callId, _args, _signal, context) => {
        receivedContext = context;
        return { content: [{ type: 'text', text: 'tool result' }] };
      },
    };
    const gateway = createGateway([
      assistantStream(assistantMessage('', model, [call]), model),
      assistantStream(assistantMessage('done'), model),
    ]);
    const runner = new TestExecuteTurn({
      sessionStore: store,
      modelGateway: gateway,
      toolDefinitions: [definition],
      defaultModel: model,
    });

    await runner.execute({ message: userMessage('use lookup') });

    expect(receivedContext).toEqual({ sessionId: expect.any(String) });
  });

  it('uses the input ExcelResource independently for each turn on one runner', async () => {
    const { store } = createStore();
    const callOne: ModelToolCall = { callId: 'call-a', name: 'lookup', arguments: {} };
    const callTwo: ModelToolCall = { callId: 'call-b', name: 'lookup', arguments: {} };
    const receivedContexts: ToolContext[] = [];
    const definition: ToolDefinition = {
      name: 'lookup',
      description: 'Lookup description',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async (_callId, _args, _signal, context) => {
        receivedContexts.push(context);
        return { content: [{ type: 'text', text: 'tool result' }] };
      },
    };
    const gateway = createGateway([
      assistantStream(assistantMessage('', model, [callOne]), model),
      assistantStream(assistantMessage('first done'), model),
      assistantStream(assistantMessage('', model, [callTwo]), model),
      assistantStream(assistantMessage('second done'), model),
    ]);
    const runner = new TestExecuteTurn({
      sessionStore: store,
      modelGateway: gateway,
      toolDefinitions: [definition],
      defaultModel: model,
    });
    const resourceA = { id: 'resource-a', filePath: 'workbook-a.xlsx' };
    const resourceB = { id: 'resource-b', filePath: 'workbook-b.xlsx' };

    const firstResult = await runner.execute({
      message: userMessage('use workbook a'),
      excelResource: resourceA,
    });
    await runner.execute({
      sessionId: firstResult.sessionId,
      message: userMessage('use workbook b'),
      excelResource: resourceB,
    });

    expect(receivedContexts).toEqual([
      { sessionId: firstResult.sessionId, excelResource: resourceA },
      { sessionId: firstResult.sessionId, excelResource: resourceB },
    ]);
  });

  it('emits session_ready before forwarding AgentSession events', async () => {
    const { store } = createStore();
    const gateway = createGateway([assistantStream(assistantMessage('done'), model)]);
    const runner = new TestExecuteTurn({
      sessionStore: store,
      modelGateway: gateway,
      toolDefinitions: [],
      defaultModel: model,
    });
    const events: TestTurnExecutionEvent[] = [];

    const result = await runner.execute(
      { message: userMessage('hello') },
      {
        onEvent: (event) => {
          events.push(event);
        },
      },
    );

    expect(events[0]).toEqual({
      type: 'session_ready',
      sessionId: result.sessionId,
      created: true,
    });
    expect(events.findIndex((event) => event.type === 'session_ready')).toBeLessThan(
      events.findIndex((event) => event.type === 'agent_start'),
    );
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'step_start',
        'message_start',
        'message_end',
        'step_end',
        'agent_end',
      ]),
    );
    expect(events.filter((event) => event.type === 'session_settled')).toHaveLength(1);
    expect(events.at(-1)).toEqual({
      type: 'session_settled',
    });
  });

  it('awaits an async execution listener before completing the turn', async () => {
    const { store } = createStore();
    const gateway = createGateway([assistantStream(assistantMessage('done'), model)]);
    const runner = new TestExecuteTurn({
      sessionStore: store,
      modelGateway: gateway,
      toolDefinitions: [],
      defaultModel: model,
    });
    const listenerStarted = createDeferred<void>();
    const releaseListener = createDeferred<void>();
    let settled = false;

    const execution = runner
      .execute(
        { message: userMessage('hello') },
        {
          onEvent: async (event) => {
            if (event.type !== 'session_settled') return;
            listenerStarted.resolve(undefined);
            await releaseListener.promise;
          },
        },
      )
      .then((result) => {
        settled = true;
        return result;
      });

    await listenerStarted.promise;
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseListener.resolve(undefined);
    await execution;
    expect(settled).toBe(true);
  });

  it('prefers input.model over defaultModel for a new session', async () => {
    const { store } = createStore();
    const gateway = createGateway(
      [assistantStream(assistantMessage('alternate', alternateModel), alternateModel)],
      [model, alternateModel],
    );
    const runner = new TestExecuteTurn({
      sessionStore: store,
      modelGateway: gateway,
      toolDefinitions: [],
      defaultModel: model,
    });

    await runner.execute({ message: userMessage('hello'), model: alternateModel });

    expect(gateway.requestedModels[0]).toBe(alternateModel);
  });

  it('uses defaultModel when a new session has no input model', async () => {
    const { store } = createStore();
    const gateway = createGateway(
      [assistantStream(assistantMessage('default', alternateModel), alternateModel)],
      [alternateModel],
    );
    const runner = new TestExecuteTurn({
      sessionStore: store,
      modelGateway: gateway,
      toolDefinitions: [],
      defaultModel: alternateModel,
    });

    await runner.execute({ message: userMessage('hello') });

    expect(gateway.requestedModels[0]).toBe(alternateModel);
  });

  it('lets createAgentSession restore the model for an existing session', async () => {
    const { store } = createStore();
    const existing = store.create();
    appendPersisted(store, existing, () => existing.appendModelChange(model.provider, model.id));
    const gateway = createGateway(
      [assistantStream(assistantMessage('restored', model), model)],
      [model, alternateModel],
    );
    const runner = new TestExecuteTurn({
      sessionStore: store,
      modelGateway: gateway,
      toolDefinitions: [],
      defaultModel: alternateModel,
    });

    await runner.execute({ sessionId: existing.getHeader().id, message: userMessage('resume') });

    expect(gateway.requestedModels[0]).toBe(model);
  });

  it('passes thinkingLevel through and keeps createAgentSession clamping behavior', async () => {
    const { store } = createStore();
    const gateway = createGateway(
      [assistantStream(assistantMessage('clamped', lowOnlyModel), lowOnlyModel)],
      [lowOnlyModel],
    );
    const runner = new TestExecuteTurn({
      sessionStore: store,
      modelGateway: gateway,
      toolDefinitions: [],
      defaultModel: lowOnlyModel,
    });

    const result = await runner.execute({
      message: userMessage('think'),
      thinkingLevel: 'high',
    });
    const loaded = store.load(result.sessionId);

    expect(gateway.requestedOptions[0]?.reasoning).toBe('low');
    expect(buildSessionContext(loaded).thinkingLevel).toBe('low');
  });

  it('disposes AgentSession after a successful prompt', async () => {
    const { store } = createStore();
    const dispose = vi.spyOn(AgentSession.prototype, 'dispose');
    const runner = new TestExecuteTurn({
      sessionStore: store,
      modelGateway: createGateway([assistantStream(assistantMessage('done'), model)]),
      toolDefinitions: [],
      defaultModel: model,
    });

    await runner.execute({ message: userMessage('hello') });

    expect(dispose).toHaveBeenCalledOnce();
  });

  it('disposes AgentSession when prompt fails', async () => {
    const { store: fileStore } = createStore();
    let createdSession: Session | undefined;
    const sessionStore: SessionStore = {
      create: () => {
        createdSession = fileStore.create();
        return createdSession;
      },
      load: (sessionId) => fileStore.load(sessionId),
      appendEntry: (sessionId, entry) => {
        if (entry.type === 'message') throw new Error('prompt persistence failed');
        fileStore.appendEntry(sessionId, entry);
      },
      saveMetadata: (sessionId, metadata) => fileStore.saveMetadata(sessionId, metadata),
    };
    const dispose = vi.spyOn(AgentSession.prototype, 'dispose');
    const gateway = createGateway([assistantStream(assistantMessage('will fail'), model)], [model]);
    const runner = new TestExecuteTurn({
      sessionStore,
      modelGateway: gateway,
      toolDefinitions: [],
      defaultModel: model,
    });

    await expect(runner.execute({ message: userMessage('hello') })).rejects.toThrow(
      'prompt persistence failed',
    );
    expect(dispose).not.toHaveBeenCalled();
    expect(createdSession).toBeDefined();
    expect(messageEntries(fileStore.load(createdSession!.getHeader().id))).toEqual([]);
  });

  it('unsubscribes before disposing when the event listener fails', async () => {
    const { store } = createStore();
    const order: string[] = [];
    const originalSubscribe = AgentSession.prototype.subscribe;
    const originalDispose = AgentSession.prototype.dispose;
    vi.spyOn(AgentSession.prototype, 'subscribe').mockImplementation(function (
      this: AgentSession,
      listener,
    ) {
      const unsubscribe = originalSubscribe.call(this, listener);
      return () => {
        order.push('unsubscribe');
        unsubscribe();
      };
    });
    vi.spyOn(AgentSession.prototype, 'dispose').mockImplementation(function (this: AgentSession) {
      order.push('dispose');
      originalDispose.call(this);
    });
    const runner = new TestExecuteTurn({
      sessionStore: store,
      modelGateway: createGateway([assistantStream(assistantMessage('done'), model)]),
      toolDefinitions: [],
      defaultModel: model,
    });

    await expect(
      runner.execute(
        { message: userMessage('hello') },
        {
          onEvent: (event) => {
            if (event.type === 'agent_start') throw new Error('event listener failed');
          },
        },
      ),
    ).rejects.toThrow('event listener failed');
    expect(order).toEqual(['unsubscribe', 'dispose']);
  });

  it('serializes concurrent turns for one existing session after loading under the lock', async () => {
    const { store } = createStore();
    const initialRunner = new TestExecuteTurn({
      sessionStore: store,
      modelGateway: createGateway([assistantStream(assistantMessage('history response'), model)]),
      toolDefinitions: [],
      defaultModel: model,
    });
    const initialResult = await initialRunner.execute({ message: userMessage('history') });
    const loadMessageCounts: number[] = [];
    const sessionStore: SessionStore = {
      create: () => store.create(),
      load: (sessionId) => {
        const session = store.load(sessionId);
        loadMessageCounts.push(messageEntries(session).length);
        return session;
      },
      appendEntry: (sessionId, entry) => store.appendEntry(sessionId, entry),
      saveMetadata: (sessionId, metadata) => store.saveMetadata(sessionId, metadata),
    };
    const firstStarted = createDeferred<void>();
    const releaseFirst = createDeferred<void>();
    const firstResponse = assistantMessage('first response');
    const secondResponse = assistantMessage('second response');
    const gateway = createGateway([
      waitingAssistantStream(firstResponse, model, firstStarted, releaseFirst),
      assistantStream(secondResponse, model),
    ]);
    const runner = new TestExecuteTurn({
      sessionStore,
      modelGateway: gateway,
      toolDefinitions: [],
      defaultModel: model,
    });

    const firstRun = runner.execute({
      sessionId: initialResult.sessionId,
      message: userMessage('user-1'),
    });
    await firstStarted.promise;
    const secondRun = runner.execute({
      sessionId: initialResult.sessionId,
      message: userMessage('user-2'),
    });
    await Promise.resolve();

    expect(loadMessageCounts).toEqual([2]);
    releaseFirst.resolve(undefined);
    await Promise.all([firstRun, secondRun]);

    const loaded = store.load(initialResult.sessionId);
    expect(loadMessageCounts).toEqual([2, 4]);
    expect(messageEntries(loaded)).toEqual([
      userMessage('history'),
      assistantMessage('history response'),
      userMessage('user-1'),
      firstResponse,
      userMessage('user-2'),
      secondResponse,
    ]);
    expect(gateway.requestedContexts[1]?.messages).toEqual([
      userMessage('history'),
      assistantMessage('history response'),
      userMessage('user-1'),
      firstResponse,
      userMessage('user-2'),
    ]);
  });

  it('allows turns for different existing sessions to run concurrently', async () => {
    const { store } = createStore();
    const firstSession = store.create();
    appendPersisted(store, firstSession, () =>
      firstSession.appendModelChange(model.provider, model.id),
    );
    const secondSession = store.create();
    appendPersisted(store, secondSession, () =>
      secondSession.appendModelChange(model.provider, model.id),
    );
    const firstStarted = createDeferred<void>();
    const secondStarted = createDeferred<void>();
    const firstRelease = createDeferred<void>();
    const secondRelease = createDeferred<void>();
    const gateway = createGateway([
      waitingAssistantStream(assistantMessage('first response'), model, firstStarted, firstRelease),
      waitingAssistantStream(
        assistantMessage('second response'),
        model,
        secondStarted,
        secondRelease,
      ),
    ]);
    const runner = new TestExecuteTurn({
      sessionStore: store,
      modelGateway: gateway,
      toolDefinitions: [],
      defaultModel: model,
    });

    const firstRun = runner.execute({
      sessionId: firstSession.getHeader().id,
      message: userMessage('first input'),
    });
    const secondRun = runner.execute({
      sessionId: secondSession.getHeader().id,
      message: userMessage('second input'),
    });

    await Promise.all([firstStarted.promise, secondStarted.promise]);
    firstRelease.resolve(undefined);
    secondRelease.resolve(undefined);
    await Promise.all([firstRun, secondRun]);

    expect(gateway.requestedContexts).toHaveLength(2);
  });
});
