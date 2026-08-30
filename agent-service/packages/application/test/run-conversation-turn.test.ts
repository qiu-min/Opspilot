import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentMessage, AgentToolResult } from '@opspilot/agent-runtime';
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
  createCompactionSummaryMessage,
  type ContextManager,
  FileSystemSessionStore,
  RunConversationTurn,
  SessionManager,
  type SessionStore,
  type ToolDefinition,
} from '../src/index.js';

const directories: string[] = [];

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
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createStore(): { directory: string; store: FileSystemSessionStore } {
  const directory = mkdtempSync(join(tmpdir(), 'opspilot-conversation-'));
  directories.push(directory);
  return { directory, store: new FileSystemSessionStore(directory) };
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

  return {
    getProviders: () => [],
    getModels: () => registeredModels,
    getModel: (provider, id) =>
      registeredModels.find((candidate) => candidate.provider === provider && candidate.id === id),
    stream,
    complete: async () => {
      if (completion === undefined) throw new Error('complete is not used by this test.');
      return completion;
    },
    requestedModels,
    requestedContexts,
    requestedOptions,
  };
}

function messageEntries(sessionManager: SessionManager): AgentMessage[] {
  return sessionManager
    .getEntries()
    .filter((entry) => entry.type === 'message')
    .map((entry) => entry.message);
}

describe('RunConversationTurn', () => {
  it('keeps the original behavior when onEvent is omitted', async () => {
    const { directory, store } = createStore();
    const inputMessage = userMessage('hello');
    const response = assistantMessage('world');
    const gateway = createGateway([assistantStream(response, model)]);
    const runner = new RunConversationTurn({
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
    expect(readFileSync(join(directory, `${result.sessionId}.jsonl`), 'utf8')).toContain(
      result.sessionId,
    );
  });

  it('loads an existing session, restores history, and appends the next turn once', async () => {
    const { store } = createStore();
    const firstInput = userMessage('first');
    const firstResponse = assistantMessage('first response');
    const firstRunner = new RunConversationTurn({
      sessionStore: store,
      modelGateway: createGateway([assistantStream(firstResponse, model)]),
      toolDefinitions: [],
      defaultModel: model,
    });
    const firstResult = await firstRunner.execute({ message: firstInput });

    const secondInput = userMessage('second');
    const secondResponse = assistantMessage('second response');
    const secondGateway = createGateway([assistantStream(secondResponse, model)]);
    const secondRunner = new RunConversationTurn({
      sessionStore: store,
      modelGateway: secondGateway,
      toolDefinitions: [],
      defaultModel: model,
    });

    const secondResult = await secondRunner.execute({
      sessionId: firstResult.sessionId,
      message: secondInput,
    });
    const loaded = store.load(firstResult.sessionId);

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
    const compactingModel = { ...model, contextWindow: 1 };
    const firstInput = userMessage('first input');
    const firstResponse = assistantMessage('first response', compactingModel);
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
    const runner = new RunConversationTurn({
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
    const compaction = afterCompaction
      .getEntries()
      .find((entry) => entry.type === 'compaction');

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
    expect(
      store
        .load(firstResult.sessionId)
        .getEntries()
        .filter((entry) => entry.type === 'message')
        .map((entry) => entry.message),
    ).toEqual([firstInput, firstResponse, secondInput, secondResponse]);
  });

  it('keeps a successful turn successful when post-run compaction fails', async () => {
    const { store } = createStore();
    const compactingModel = { ...model, contextWindow: 1 };
    const inputMessage = userMessage('input');
    const response = assistantMessage('response', compactingModel);
    const gateway = createGateway(
      [assistantStream(response, compactingModel)],
      [compactingModel],
    );
    const runner = new RunConversationTurn({
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
    const firstRunner = new RunConversationTurn({
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
    const secondRunner = new RunConversationTurn({
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
    let receivedContext: { readonly sessionId: string } | undefined;
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
    const runner = new RunConversationTurn({
      sessionStore: store,
      modelGateway: gateway,
      toolDefinitions: [definition],
      defaultModel: model,
    });
    const events: AgentEvent[] = [];

    const result = await runner.execute(
      { message: userMessage('use lookup') },
      {
        onEvent: (event) => {
          events.push(event);
        },
      },
    );

    expect(receivedContext).toEqual({ sessionId: result.sessionId });
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
          (event): event is Extract<AgentEvent, { type: 'tool_execution_start' }> =>
            event.type === 'tool_execution_start',
        )
        .map((event) => event.toolCall.callId),
    ).toEqual([call.callId]);
    expect(
      events
        .filter(
          (event): event is Extract<AgentEvent, { type: 'tool_execution_end' }> =>
            event.type === 'tool_execution_end',
        )
        .map((event) => event.toolCall.callId),
    ).toEqual([call.callId]);
  });

  it('forwards AgentSession events to the execution listener', async () => {
    const { store } = createStore();
    const gateway = createGateway([assistantStream(assistantMessage('done'), model)]);
    const runner = new RunConversationTurn({
      sessionStore: store,
      modelGateway: gateway,
      toolDefinitions: [],
      defaultModel: model,
    });
    const events: AgentEvent[] = [];

    await runner.execute(
      { message: userMessage('hello') },
      {
        onEvent: (event) => {
          events.push(event);
        },
      },
    );

    expect(events[0]).toEqual({ type: 'agent_start' });
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'turn_start',
        'message_start',
        'message_end',
        'turn_end',
        'agent_end',
      ]),
    );
    expect(events.at(-1)).toEqual({
      type: 'agent_end',
      messages: expect.any(Array),
    });
  });

  it('prefers input.model over defaultModel for a new session', async () => {
    const { store } = createStore();
    const gateway = createGateway(
      [assistantStream(assistantMessage('alternate', alternateModel), alternateModel)],
      [model, alternateModel],
    );
    const runner = new RunConversationTurn({
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
    const runner = new RunConversationTurn({
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
    existing.appendModelChange(model.provider, model.id);
    const gateway = createGateway(
      [assistantStream(assistantMessage('restored', model), model)],
      [model, alternateModel],
    );
    const runner = new RunConversationTurn({
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
    const runner = new RunConversationTurn({
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
    expect(loaded.buildSessionContext().thinkingLevel).toBe('low');
  });

  it('disposes AgentSession after a successful prompt', async () => {
    const { store } = createStore();
    const dispose = vi.spyOn(AgentSession.prototype, 'dispose');
    const runner = new RunConversationTurn({
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
    const sessionStore: SessionStore = {
      create: () => {
        const sessionManager = fileStore.create();
        const appendMessage = sessionManager.appendMessage.bind(sessionManager);
        vi.spyOn(sessionManager, 'appendMessage')
          .mockImplementationOnce(appendMessage)
          .mockImplementation(() => {
            throw new Error('prompt persistence failed');
          });
        return sessionManager;
      },
      load: (sessionId) => fileStore.load(sessionId),
    };
    const dispose = vi.spyOn(AgentSession.prototype, 'dispose');
    const gateway = createGateway([assistantStream(assistantMessage('will fail'), model)], [model]);
    const runner = new RunConversationTurn({
      sessionStore,
      modelGateway: gateway,
      toolDefinitions: [],
      defaultModel: model,
    });

    await expect(runner.execute({ message: userMessage('hello') })).rejects.toThrow(
      'prompt persistence failed',
    );
    expect(dispose).toHaveBeenCalledOnce();
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
    const runner = new RunConversationTurn({
      sessionStore: store,
      modelGateway: createGateway([assistantStream(assistantMessage('done'), model)]),
      toolDefinitions: [],
      defaultModel: model,
    });

    await expect(
      runner.execute(
        { message: userMessage('hello') },
        {
          onEvent: () => {
            throw new Error('event listener failed');
          },
        },
      ),
    ).rejects.toThrow('event listener failed');
    expect(order).toEqual(['unsubscribe', 'dispose']);
  });

  it('serializes concurrent turns for one existing session after loading under the lock', async () => {
    const { store } = createStore();
    const initialRunner = new RunConversationTurn({
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
        const sessionManager = store.load(sessionId);
        loadMessageCounts.push(messageEntries(sessionManager).length);
        return sessionManager;
      },
    };
    const firstStarted = createDeferred<void>();
    const releaseFirst = createDeferred<void>();
    const firstResponse = assistantMessage('first response');
    const secondResponse = assistantMessage('second response');
    const gateway = createGateway([
      waitingAssistantStream(firstResponse, model, firstStarted, releaseFirst),
      assistantStream(secondResponse, model),
    ]);
    const runner = new RunConversationTurn({
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
    firstSession.appendModelChange(model.provider, model.id);
    const secondSession = store.create();
    secondSession.appendModelChange(model.provider, model.id);
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
    const runner = new RunConversationTurn({
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
