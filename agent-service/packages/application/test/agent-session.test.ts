import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createModelEventStream,
  type AssistantMessage,
  type Model,
  type ModelEventStream,
  type ModelGateway,
  type ModelToolCall,
  type Options,
} from '@opspilot/model-gateway';
import type { AgentMessage, AgentTool } from '@opspilot/agent-runtime';

import {
  createAgentSession,
  createCompactionSummaryMessage,
  DefaultContextManager,
  prepareCompaction,
  SessionManager,
  type AgentSessionEvent,
  type CompactionService,
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

const lowOnlyModel: Model = {
  ...model,
  id: 'low-only-model',
  name: 'Low Only Model',
  thinkingLevelMap: { low: 'low' },
};

const alternateHighModel: Model = {
  ...model,
  id: 'alternate-high-model',
  name: 'Alternate High Model',
};

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function userMessage(text: string): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text }] };
}

function assistantMessage(text: string, toolCalls?: readonly ModelToolCall[]): AssistantMessage {
  return {
    role: 'assistant',
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [{ type: 'text', text }],
    finishReason: toolCalls === undefined ? 'stop' : 'tool_calls',
    ...(toolCalls === undefined ? {} : { toolCalls }),
  };
}

function assistantStream(message: AssistantMessage, streamModel: Model = model): ModelEventStream {
  return createModelEventStream(async (controller) => {
    controller.emit({
      type: 'start',
      model: streamModel,
      partial: { ...message, content: [], finishReason: 'pending' },
    });
    controller.complete(message);
  });
}

function createGateway(
  streams: readonly ModelEventStream[],
  registeredModels: readonly Model[] = [model],
): ModelGateway & {
  readonly stream: ReturnType<typeof vi.fn>;
} {
  let streamIndex = 0;
  const stream = vi.fn((_model: Model, _context, _options?: Options) => {
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
      throw new Error('complete is not used by this test.');
    },
  };
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function messageEntries(sessionManager: SessionManager): AgentMessage[] {
  return sessionManager
    .getEntries()
    .filter((entry) => entry.type === 'message')
    .map((entry) => entry.message);
}

describe('AgentSession composition and persistence', () => {
  it('returns a copied message list from the default context manager', async () => {
    const messages = [userMessage('A')];
    const result = await new DefaultContextManager().prepare({
      messages,
      model,
      tools: [],
    });

    expect(result.messages).toEqual(messages);
    expect(result.messages).not.toBe(messages);
  });

  it('requires a model for a new session and fails clearly for an unknown saved model', () => {
    const newSession = SessionManager.inMemory();
    const gateway = createGateway([]);

    expect(() => createAgentSession({ sessionManager: newSession, modelGateway: gateway })).toThrow(
      'createAgentSession requires a model for a new session',
    );

    const savedModelSession = SessionManager.inMemory();
    savedModelSession.appendModelChange('missing-provider', 'missing-model');
    expect(() =>
      createAgentSession({ sessionManager: savedModelSession, modelGateway: gateway }),
    ).toThrow('Unable to restore session model missing-provider/missing-model');
  });

  it('rejects an explicit unknown model before writing session state', () => {
    const sessionManager = SessionManager.inMemory();
    const unknownModel = { ...model, provider: 'unknown-provider', id: 'unknown-model' };
    const gateway = createGateway([]);

    expect(() =>
      createAgentSession({ sessionManager, modelGateway: gateway, model: unknownModel }),
    ).toThrow('Explicit model unknown-provider/unknown-model is not registered');
    expect(sessionManager.getEntries()).toEqual([]);
  });

  it('uses the gateway canonical model for explicit model input', () => {
    const sessionManager = SessionManager.inMemory();
    const callerModel = { ...model, api: 'caller-api', baseUrl: 'https://caller.example.test' };
    const session = createAgentSession({
      sessionManager,
      modelGateway: createGateway([]),
      model: callerModel,
    });

    expect(session.state.model).toBe(model);
    expect(sessionManager.getEntries()).toContainEqual(
      expect.objectContaining({
        type: 'model_change',
        provider: model.provider,
        modelId: model.id,
      }),
    );
    session.dispose();
  });

  it('creates, persists, reloads, resumes, and appends without duplicating history', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'opspilot-agent-session-'));
    directories.push(directory);
    const filePath = join(directory, 'session.jsonl');
    const sessionManager = SessionManager.createPersisted(filePath);
    const firstGateway = createGateway([assistantStream(assistantMessage('B'))]);
    const firstSession = createAgentSession({
      sessionManager,
      modelGateway: firstGateway,
      model,
      thinkingLevel: 'high',
    });

    expect(firstSession.state.model).toBe(model);
    expect(firstSession.state.thinkingLevel).toBe('high');
    expect(firstSession.state.messages).toEqual([]);
    expect(sessionManager.getEntries().map((entry) => entry.type)).toEqual([
      'model_change',
      'thinking_level_change',
    ]);

    await firstSession.prompt(userMessage('A'));
    expect(messageEntries(sessionManager)).toEqual([userMessage('A'), assistantMessage('B')]);
    firstSession.dispose();

    const loaded = SessionManager.load(filePath);
    const entryCountBeforeResume = loaded.getEntries().length;
    const resumeGateway = createGateway([assistantStream(assistantMessage('D'))]);
    const resumed = createAgentSession({ sessionManager: loaded, modelGateway: resumeGateway });

    expect(resumed.state.model).toBe(model);
    expect(resumed.state.thinkingLevel).toBe('high');
    expect(resumed.state.messages).toEqual([userMessage('A'), assistantMessage('B')]);
    expect(loaded.getEntries()).toHaveLength(entryCountBeforeResume);

    await resumed.prompt(userMessage('C'));
    resumed.dispose();

    const reloaded = SessionManager.load(filePath);
    expect(messageEntries(reloaded)).toEqual([
      userMessage('A'),
      assistantMessage('B'),
      userMessage('C'),
      assistantMessage('D'),
    ]);
    expect(reloaded.getEntries().filter((entry) => entry.type === 'message')).toHaveLength(4);
  });

  it('persists tool results once through message_end and rejects calls after dispose', async () => {
    const sessionManager = SessionManager.inMemory();
    const call: ModelToolCall = { callId: 'call_1', name: 'lookup', arguments: {} };
    const tool: AgentTool = {
      name: 'lookup',
      description: 'Lookup test data',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => ({ content: [{ type: 'text', text: 'result' }] }),
    };
    const gateway = createGateway([
      assistantStream(assistantMessage('', [call])),
      assistantStream(assistantMessage('done')),
    ]);
    const session = createAgentSession({
      sessionManager,
      modelGateway: gateway,
      model,
      tools: [tool],
    });

    await session.prompt(userMessage('use tool'));

    expect(messageEntries(sessionManager).map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
    expect(gateway.stream).toHaveBeenCalledTimes(2);

    session.dispose();
    session.dispose();
    await expect(session.prompt(userMessage('after dispose'))).rejects.toThrow(
      'AgentSession is disposed.',
    );
    expect(() => session.subscribe(() => undefined)).toThrow('AgentSession is disposed.');

    expect(messageEntries(sessionManager).map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
  });

  it('awaits AgentSession event listeners sequentially before continuing the Runtime event', async () => {
    const listenerStarted = createDeferred<void>();
    const releaseListener = createDeferred<void>();
    const events: string[] = [];
    const session = createAgentSession({
      sessionManager: SessionManager.inMemory(),
      modelGateway: createGateway([assistantStream(assistantMessage('done'))]),
      model,
    });

    session.subscribe(async (event) => {
      if (event.type !== 'agent_start') return;
      events.push('first-start');
      listenerStarted.resolve(undefined);
      await releaseListener.promise;
      events.push('first-end');
    });
    session.subscribe((event) => {
      if (event.type === 'agent_start') events.push('second');
    });

    let settled = false;
    const run = session.prompt(userMessage('input')).then(
      (messages) => {
        settled = true;
        return messages;
      },
      (error: unknown) => {
        settled = true;
        throw error;
      },
    );
    await listenerStarted.promise;
    await Promise.resolve();

    expect(events).toEqual(['first-start']);
    expect(settled).toBe(false);

    releaseListener.resolve(undefined);
    await run;
    expect(events).toEqual(['first-start', 'first-end', 'second']);
    session.dispose();
  });

  it('rejects a second prompt during pre-prompt compaction', async () => {
    const compactingModel = { ...model, contextWindow: 100 };
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendModelChange(compactingModel.provider, compactingModel.id);
    sessionManager.appendMessage(userMessage('x'.repeat(500)));
    sessionManager.appendMessage(assistantMessage('old response'));
    const compactionStarted = createDeferred<void>();
    const releaseCompaction = createDeferred<void>();
    let compactionCalls = 0;
    const response = assistantMessage('response');
    const gateway = createGateway([assistantStream(response)], [compactingModel]);
    const session = createAgentSession({
      sessionManager,
      modelGateway: gateway,
      model: compactingModel,
      compactionService: {
        compact: async () => {
          compactionCalls += 1;
          compactionStarted.resolve(undefined);
          await releaseCompaction.promise;
          return { summary: 'Summary' };
        },
      },
      compactionSettings: { enabled: true, reserveTokens: 0, keepRecentTokens: 1 },
    });

    const firstPrompt = session.prompt(userMessage('A'));
    await compactionStarted.promise;

    await expect(session.prompt(userMessage('B'))).rejects.toThrow(
      'AgentSession is already processing a prompt.',
    );
    expect(compactionCalls).toBe(1);
    expect(gateway.stream).not.toHaveBeenCalled();

    releaseCompaction.resolve(undefined);
    await firstPrompt;
    expect(gateway.stream).toHaveBeenCalledOnce();
    session.dispose();
  });

  it('rejects a second prompt while the Runtime is running', async () => {
    const runtimeStarted = createDeferred<void>();
    const releaseRuntime = createDeferred<void>();
    const response = assistantMessage('response');
    const gateway = createGateway([]);
    gateway.stream.mockImplementation(() =>
      createModelEventStream(async (controller) => {
        controller.emit({
          type: 'start',
          model,
          partial: { ...response, content: [], finishReason: 'pending' },
        });
        runtimeStarted.resolve(undefined);
        await releaseRuntime.promise;
        controller.complete(response);
      }),
    );
    const session = createAgentSession({
      sessionManager: SessionManager.inMemory(),
      modelGateway: gateway,
      model,
    });

    const firstPrompt = session.prompt(userMessage('A'));
    await runtimeStarted.promise;

    await expect(session.prompt(userMessage('B'))).rejects.toThrow(
      'AgentSession is already processing a prompt.',
    );
    expect(gateway.stream).toHaveBeenCalledOnce();

    releaseRuntime.resolve(undefined);
    await firstPrompt;
    session.dispose();
  });

  it('rejects a second prompt during post-run compaction while the Runtime is idle', async () => {
    const compactingModel = { ...model, contextWindow: 1 };
    const compactionStarted = createDeferred<void>();
    const releaseCompaction = createDeferred<void>();
    let compactionCalls = 0;
    const gateway = createGateway(
      [assistantStream(assistantMessage('response'))],
      [compactingModel],
    );
    const session = createAgentSession({
      sessionManager: SessionManager.inMemory(),
      modelGateway: gateway,
      model: compactingModel,
      compactionService: {
        compact: async () => {
          compactionCalls += 1;
          compactionStarted.resolve(undefined);
          await releaseCompaction.promise;
          return { summary: 'Summary' };
        },
      },
      compactionSettings: { enabled: true, reserveTokens: 0, keepRecentTokens: 1 },
    });

    const firstPrompt = session.prompt(userMessage('A'));
    await compactionStarted.promise;
    expect(session.state.isRunning).toBe(false);

    await expect(session.prompt(userMessage('B'))).rejects.toThrow(
      'AgentSession is already processing a prompt.',
    );
    expect(compactionCalls).toBe(1);
    expect(gateway.stream).toHaveBeenCalledOnce();

    releaseCompaction.resolve(undefined);
    await firstPrompt;
    session.dispose();
  });

  it('allows the next prompt after the previous prompt fully settles', async () => {
    const gateway = createGateway([
      assistantStream(assistantMessage('first')),
      assistantStream(assistantMessage('second')),
    ]);
    const session = createAgentSession({
      sessionManager: SessionManager.inMemory(),
      modelGateway: gateway,
      model,
    });

    await expect(session.prompt(userMessage('A'))).resolves.toEqual([
      userMessage('A'),
      assistantMessage('first'),
    ]);
    await expect(session.prompt(userMessage('B'))).resolves.toEqual([
      userMessage('B'),
      assistantMessage('second'),
    ]);
    expect(gateway.stream).toHaveBeenCalledTimes(2);
    session.dispose();
  });

  it('releases the prompt guard when prompt rejects', async () => {
    const compactingModel = { ...model, contextWindow: 100 };
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendModelChange(compactingModel.provider, compactingModel.id);
    sessionManager.appendMessage(userMessage('x'.repeat(500)));
    sessionManager.appendMessage(assistantMessage('old response'));
    const response = assistantMessage('response');
    const gateway = createGateway([assistantStream(response)], [compactingModel]);
    const session = createAgentSession({
      sessionManager,
      modelGateway: gateway,
      model: compactingModel,
      compactionService: {
        compact: async () => ({ summary: 'Summary' }),
      },
      compactionSettings: { enabled: true, reserveTokens: 0, keepRecentTokens: 1 },
    });
    const unsubscribe = session.subscribe((event) => {
      if (event.type === 'compaction_start') throw new Error('prompt listener failed');
    });

    await expect(session.prompt(userMessage('A'))).rejects.toThrow('prompt listener failed');
    unsubscribe();

    await expect(session.prompt(userMessage('B'))).resolves.toEqual([userMessage('B'), response]);
    expect(gateway.stream).toHaveBeenCalledOnce();
    session.dispose();
  });

  it('rejects dispose while running and keeps persistence until the run is idle', async () => {
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    let resolveRelease!: () => void;
    const release = new Promise<void>((resolve) => {
      resolveRelease = resolve;
    });
    const sessionManager = SessionManager.inMemory();
    const gateway = createGateway([]);
    gateway.stream.mockImplementation(() =>
      createModelEventStream(async (controller) => {
        const message = assistantMessage('running');
        controller.emit({
          type: 'start',
          model,
          partial: { ...message, content: [], finishReason: 'pending' },
        });
        resolveStarted();
        await release;
        controller.complete(message);
      }),
    );
    const session = createAgentSession({
      sessionManager,
      modelGateway: gateway,
      model,
    });

    const run = session.prompt(userMessage('running input'));
    await started;
    expect(() => session.dispose()).toThrow(
      'Cannot dispose AgentSession while Agent is running. Wait for idle first.',
    );

    resolveRelease();
    await run;
    await session.waitForIdle();
    session.dispose();

    expect(messageEntries(sessionManager)).toEqual([
      userMessage('running input'),
      assistantMessage('running'),
    ]);
  });

  it('refreshes the same AgentSession runtime after post-run compaction', async () => {
    const compactingModel = { ...model, contextWindow: 1000 };
    const sessionManager = SessionManager.inMemory();
    const firstResponse = {
      ...assistantMessage('B'),
      usage: { inputTokens: 900, outputTokens: 101, totalTokens: 1001 },
    };
    const secondInput = userMessage('C');
    const gateway = createGateway(
      [assistantStream(firstResponse), assistantStream(assistantMessage('D'))],
      [compactingModel],
    );
    const compactionSettings = { enabled: true, reserveTokens: 0, keepRecentTokens: 1 };
    const compactionService: CompactionService = {
      compact: async () => ({ summary: 'Summary' }),
    };
    const session = createAgentSession({
      sessionManager,
      modelGateway: gateway,
      model: compactingModel,
      compactionService,
      compactionSettings,
    });
    const events: AgentSessionEvent[] = [];
    session.subscribe((event) => {
      events.push(event);
    });

    await session.prompt(userMessage('A'));

    const entriesBeforeCompaction = sessionManager
      .getEntries()
      .filter((entry) => entry.type !== 'compaction');
    const preparation = prepareCompaction(entriesBeforeCompaction, compactionSettings);
    const compaction = sessionManager.getEntries().find((entry) => entry.type === 'compaction');
    expect(preparation).toBeDefined();
    expect(compaction).toEqual(
      expect.objectContaining({
        firstKeptEntryId: preparation!.firstKeptEntryId,
        tokensBefore: preparation!.tokensBefore,
      }),
    );

    expect(sessionManager.buildSessionContext().messages).toEqual(session.agent.state.messages);
    expect(session.agent.state.messages).toEqual([
      createCompactionSummaryMessage('Summary'),
      firstResponse,
    ]);
    expect(events.filter((event) => event.type.startsWith('compaction_'))).toEqual([
      { type: 'compaction_start', reason: 'threshold' },
      expect.objectContaining({
        type: 'compaction_end',
        reason: 'threshold',
        result: {
          summary: 'Summary',
          firstKeptEntryId: expect.any(String),
          tokensBefore: 1001,
        },
        aborted: false,
      }),
    ]);

    await session.prompt(secondInput);

    const secondContext = gateway.stream.mock.calls[1]?.[1] as
      { readonly messages: readonly AgentMessage[] } | undefined;
    expect(secondContext?.messages).toEqual([
      createCompactionSummaryMessage('Summary'),
      firstResponse,
      secondInput,
    ]);
    session.dispose();
  });

  it('emits a fail-soft compaction end event when summary generation fails', async () => {
    const compactingModel = { ...model, contextWindow: 1 };
    const sessionManager = SessionManager.inMemory();
    const response = assistantMessage('response');
    const gateway = createGateway([assistantStream(response)], [compactingModel]);
    const session = createAgentSession({
      sessionManager,
      modelGateway: gateway,
      model: compactingModel,
      compactionService: {
        compact: async () => {
          throw new Error('summary generation failed');
        },
      },
      compactionSettings: { enabled: true, reserveTokens: 0, keepRecentTokens: 1 },
    });
    const events: AgentSessionEvent[] = [];
    session.subscribe((event) => {
      events.push(event);
    });

    await expect(session.prompt(userMessage('input'))).resolves.toEqual([
      userMessage('input'),
      response,
    ]);

    expect(events.filter((event) => event.type.startsWith('compaction_'))).toEqual([
      { type: 'compaction_start', reason: 'threshold' },
      {
        type: 'compaction_end',
        reason: 'threshold',
        result: undefined,
        aborted: false,
        errorMessage: 'summary generation failed',
      },
    ]);
    session.dispose();
  });

  it('does not run compaction or emit an end event when the start listener fails', async () => {
    const compactingModel = { ...model, contextWindow: 100 };
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendModelChange(compactingModel.provider, compactingModel.id);
    sessionManager.appendMessage(userMessage('x'.repeat(500)));
    sessionManager.appendMessage(assistantMessage('old response'));
    let compactionCalls = 0;
    const events: AgentSessionEvent[] = [];
    const session = createAgentSession({
      sessionManager,
      modelGateway: createGateway([], [compactingModel]),
      model: compactingModel,
      compactionService: {
        compact: async () => {
          compactionCalls += 1;
          throw new Error('compaction must not start');
        },
      },
      compactionSettings: { enabled: true, reserveTokens: 0, keepRecentTokens: 1 },
    });
    session.subscribe((event) => {
      events.push(event);
      if (event.type === 'compaction_start') throw new Error('start listener failed');
    });

    await expect(session.prompt(userMessage('new input'))).rejects.toThrow('start listener failed');
    expect(compactionCalls).toBe(0);
    expect(events).toEqual([{ type: 'compaction_start', reason: 'threshold' }]);
    expect(sessionManager.getEntries().some((entry) => entry.type === 'compaction')).toBe(false);
    session.dispose();
  });

  it('keeps a successful compaction successful when its end listener fails', async () => {
    const compactingModel = { ...model, contextWindow: 1 };
    const sessionManager = SessionManager.inMemory();
    let compactionCalls = 0;
    const events: AgentSessionEvent[] = [];
    const response = assistantMessage('response');
    const session = createAgentSession({
      sessionManager,
      modelGateway: createGateway([assistantStream(response)], [compactingModel]),
      model: compactingModel,
      compactionService: {
        compact: async () => {
          compactionCalls += 1;
          return { summary: 'Summary' };
        },
      },
      compactionSettings: { enabled: true, reserveTokens: 0, keepRecentTokens: 1 },
    });
    session.subscribe((event) => {
      events.push(event);
      if (event.type === 'compaction_end') throw new Error('end listener failed');
    });

    await expect(session.prompt(userMessage('input'))).rejects.toThrow('end listener failed');
    expect(compactionCalls).toBe(1);
    expect(events.filter((event) => event.type === 'compaction_start')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'compaction_end')).toHaveLength(1);
    expect(events.at(-1)).toEqual(
      expect.objectContaining({
        type: 'compaction_end',
        result: {
          summary: 'Summary',
          firstKeptEntryId: expect.any(String),
          tokensBefore: expect.any(Number),
        },
        aborted: false,
      }),
    );
    expect(sessionManager.getEntries().some((entry) => entry.type === 'compaction')).toBe(true);
    expect(session.agent.state.messages).toEqual(sessionManager.buildSessionContext().messages);
    session.dispose();
  });

  it('skips compaction without lifecycle events when there is no new history to summarize', async () => {
    const compactingModel = { ...model, contextWindow: 1 };
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendModelChange(compactingModel.provider, compactingModel.id);
    sessionManager.appendMessage(userMessage('old input'));
    const oldResponse = assistantMessage('old response');
    sessionManager.appendMessage(oldResponse);
    sessionManager.appendCompaction('Existing summary', sessionManager.getEntries()[2]!.id, 2);
    const newInput = userMessage('new input');
    const response = {
      ...assistantMessage('response'),
      usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 },
    };
    const events: AgentSessionEvent[] = [];
    const session = createAgentSession({
      sessionManager,
      modelGateway: createGateway([assistantStream(response)], [compactingModel]),
      model: compactingModel,
      compactionService: {
        compact: async () => {
          throw new Error('compaction must not be called for a no-op');
        },
      },
      compactionSettings: { enabled: true, reserveTokens: 0, keepRecentTokens: 1 },
    });
    session.subscribe((event) => {
      events.push(event);
    });

    await expect(session.prompt(newInput)).resolves.toEqual([newInput, response]);
    expect(events.filter((event) => event.type.startsWith('compaction_'))).toEqual([]);
    expect(sessionManager.getEntries().filter((entry) => entry.type === 'compaction')).toHaveLength(
      1,
    );
    session.dispose();
  });

  it('does not start Runtime when disposed during pre-prompt compaction', async () => {
    const compactingModel = { ...model, contextWindow: 1 };
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendModelChange(compactingModel.provider, compactingModel.id);
    const oldInput = userMessage('old input');
    const oldResponse = assistantMessage('old response');
    sessionManager.appendMessage(oldInput);
    sessionManager.appendMessage(oldResponse);

    let resolveCompactionStarted!: () => void;
    const compactionStarted = new Promise<void>((resolve) => {
      resolveCompactionStarted = resolve;
    });
    let resolveCompactionRelease!: () => void;
    const compactionRelease = new Promise<void>((resolve) => {
      resolveCompactionRelease = resolve;
    });
    let compactionSignal: AbortSignal | undefined;
    const gateway = createGateway([], [compactingModel]);
    const session = createAgentSession({
      sessionManager,
      modelGateway: gateway,
      model: compactingModel,
      compactionService: {
        compact: async ({ signal }) => {
          compactionSignal = signal;
          resolveCompactionStarted();
          await compactionRelease;
          return { summary: 'aborted' };
        },
      },
      compactionSettings: { enabled: true, reserveTokens: 0, keepRecentTokens: 1 },
    });

    const run = session.prompt(userMessage('new input'));
    await compactionStarted;
    session.dispose();
    expect(compactionSignal?.aborted).toBe(true);

    resolveCompactionRelease();
    await expect(run).rejects.toThrow('AgentSession is disposed.');
    expect(gateway.stream).not.toHaveBeenCalled();
    expect(messageEntries(sessionManager)).toEqual([oldInput, oldResponse]);
    expect(sessionManager.getEntries().some((entry) => entry.type === 'compaction')).toBe(false);
  });

  it('continues the prompt when pre-prompt compaction is aborted explicitly', async () => {
    const compactingModel = { ...model, contextWindow: 100 };
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendModelChange(compactingModel.provider, compactingModel.id);
    const oldInput = userMessage('x'.repeat(500));
    const oldResponse = assistantMessage('old response');
    sessionManager.appendMessage(oldInput);
    sessionManager.appendMessage(oldResponse);

    let resolveCompactionStarted!: () => void;
    const compactionStarted = new Promise<void>((resolve) => {
      resolveCompactionStarted = resolve;
    });
    let resolveCompactionRelease!: () => void;
    const compactionRelease = new Promise<void>((resolve) => {
      resolveCompactionRelease = resolve;
    });
    let compactionSignal: AbortSignal | undefined;
    const newInput = userMessage('new input');
    const response = {
      ...assistantMessage('response'),
      usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 },
    };
    const gateway = createGateway([assistantStream(response)], [compactingModel]);
    const session = createAgentSession({
      sessionManager,
      modelGateway: gateway,
      model: compactingModel,
      compactionService: {
        compact: async ({ signal }) => {
          compactionSignal = signal;
          resolveCompactionStarted();
          await compactionRelease;
          return { summary: 'aborted' };
        },
      },
      compactionSettings: { enabled: true, reserveTokens: 0, keepRecentTokens: 1 },
    });
    const events: AgentSessionEvent[] = [];
    session.subscribe((event) => {
      events.push(event);
    });

    const run = session.prompt(newInput);
    await compactionStarted;
    session.abortCompaction();
    expect(compactionSignal?.aborted).toBe(true);

    resolveCompactionRelease();
    await expect(run).resolves.toEqual([newInput, response]);
    expect(gateway.stream).toHaveBeenCalledOnce();
    expect(messageEntries(sessionManager)).toEqual([oldInput, oldResponse, newInput, response]);
    expect(sessionManager.getEntries().some((entry) => entry.type === 'compaction')).toBe(false);
    expect(events.filter((event) => event.type.startsWith('compaction_'))).toEqual([
      { type: 'compaction_start', reason: 'threshold' },
      { type: 'compaction_end', reason: 'threshold', result: undefined, aborted: true },
    ]);
    session.dispose();
  });

  it('does not cancel pre-prompt compaction when the Runtime is aborted', async () => {
    const compactingModel = { ...model, contextWindow: 100 };
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendModelChange(compactingModel.provider, compactingModel.id);
    sessionManager.appendMessage(userMessage('x'.repeat(500)));
    sessionManager.appendMessage(assistantMessage('old response'));

    let resolveCompactionStarted!: () => void;
    const compactionStarted = new Promise<void>((resolve) => {
      resolveCompactionStarted = resolve;
    });
    let resolveCompactionRelease!: () => void;
    const compactionRelease = new Promise<void>((resolve) => {
      resolveCompactionRelease = resolve;
    });
    let compactionSignal: AbortSignal | undefined;
    const response = {
      ...assistantMessage('response'),
      usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 },
    };
    const gateway = createGateway([assistantStream(response)], [compactingModel]);
    const session = createAgentSession({
      sessionManager,
      modelGateway: gateway,
      model: compactingModel,
      compactionService: {
        compact: async ({ signal }) => {
          compactionSignal = signal;
          resolveCompactionStarted();
          await compactionRelease;
          return { summary: 'aborted' };
        },
      },
      compactionSettings: { enabled: true, reserveTokens: 0, keepRecentTokens: 1 },
    });

    const run = session.prompt(userMessage('new input'));
    await compactionStarted;
    session.abort();
    expect(compactionSignal?.aborted).toBe(false);
    resolveCompactionRelease();

    await expect(run).resolves.toEqual([userMessage('new input'), response]);
    expect(gateway.stream).toHaveBeenCalledOnce();
    session.dispose();
  });

  it('uses an independent abort signal for post-run compaction and cancels it through abortCompaction', async () => {
    const compactingModel = { ...model, contextWindow: 1 };
    let resolveCompactionStarted!: () => void;
    const compactionStarted = new Promise<void>((resolve) => {
      resolveCompactionStarted = resolve;
    });
    let resolveCompactionRelease!: () => void;
    const compactionRelease = new Promise<void>((resolve) => {
      resolveCompactionRelease = resolve;
    });
    let compactionSignal: AbortSignal | undefined;
    const sessionManager = SessionManager.inMemory();
    const compactionService: CompactionService = {
      compact: async ({ signal }) => {
        compactionSignal = signal;
        resolveCompactionStarted();
        await compactionRelease;
        return { summary: 'should not be appended after abort' };
      },
    };
    const session = createAgentSession({
      sessionManager,
      modelGateway: createGateway(
        [assistantStream(assistantMessage('response'))],
        [compactingModel],
      ),
      model: compactingModel,
      compactionService,
      compactionSettings: { enabled: true, reserveTokens: 0, keepRecentTokens: 1 },
    });

    const run = session.prompt(userMessage('input'));
    await compactionStarted;

    expect(compactionSignal).toBeDefined();
    expect(compactionSignal).not.toBe(session.agent.signal);
    session.abortCompaction();
    expect(compactionSignal?.aborted).toBe(true);

    resolveCompactionRelease();
    await run;

    expect(sessionManager.getEntries().some((entry) => entry.type === 'compaction')).toBe(false);
    expect(messageEntries(sessionManager)).toEqual([
      userMessage('input'),
      assistantMessage('response'),
    ]);
    expect(
      (session as unknown as { autoCompactionAbortController?: AbortController })
        .autoCompactionAbortController,
    ).toBeUndefined();
    session.dispose();
  });

  it('aborts post-run compaction when disposed while it is pending', async () => {
    const compactingModel = { ...model, contextWindow: 1 };
    let resolveCompactionStarted!: () => void;
    const compactionStarted = new Promise<void>((resolve) => {
      resolveCompactionStarted = resolve;
    });
    let resolveCompactionRelease!: () => void;
    const compactionRelease = new Promise<void>((resolve) => {
      resolveCompactionRelease = resolve;
    });
    let compactionSignal: AbortSignal | undefined;
    const sessionManager = SessionManager.inMemory();
    const session = createAgentSession({
      sessionManager,
      modelGateway: createGateway(
        [assistantStream(assistantMessage('response'))],
        [compactingModel],
      ),
      model: compactingModel,
      compactionService: {
        compact: async ({ signal }) => {
          compactionSignal = signal;
          resolveCompactionStarted();
          await compactionRelease;
          return { summary: 'aborted' };
        },
      },
      compactionSettings: { enabled: true, reserveTokens: 0, keepRecentTokens: 1 },
    });

    const run = session.prompt(userMessage('input'));
    await compactionStarted;
    session.dispose();
    expect(compactionSignal?.aborted).toBe(true);

    resolveCompactionRelease();
    await run;
    expect(sessionManager.getEntries().some((entry) => entry.type === 'compaction')).toBe(false);
  });

  it('persists the effective thinking level when a model override clamps it', () => {
    const sessionManager = SessionManager.inMemory();
    const initial = createAgentSession({
      sessionManager,
      modelGateway: createGateway([]),
      model,
      thinkingLevel: 'high',
    });
    initial.dispose();

    const resumed = createAgentSession({
      sessionManager,
      modelGateway: createGateway([], [lowOnlyModel]),
      model: lowOnlyModel,
    });

    expect(resumed.state.model).toBe(lowOnlyModel);
    expect(resumed.state.thinkingLevel).toBe('low');
    expect(sessionManager.buildSessionContext().model).toEqual({
      provider: lowOnlyModel.provider,
      modelId: lowOnlyModel.id,
    });
    expect(sessionManager.buildSessionContext().thinkingLevel).toBe('low');
    expect(
      sessionManager
        .getEntries()
        .slice(-2)
        .map((entry) => entry.type),
    ).toEqual(['model_change', 'thinking_level_change']);
    resumed.dispose();
  });

  it('does not append a duplicate thinking entry when the override preserves the level', () => {
    const sessionManager = SessionManager.inMemory();
    const initial = createAgentSession({
      sessionManager,
      modelGateway: createGateway([]),
      model,
      thinkingLevel: 'high',
    });
    initial.dispose();
    const entryCountBeforeResume = sessionManager.getEntries().length;

    const resumed = createAgentSession({
      sessionManager,
      modelGateway: createGateway([], [alternateHighModel]),
      model: alternateHighModel,
    });

    expect(resumed.state.thinkingLevel).toBe('high');
    expect(sessionManager.getEntries()).toHaveLength(entryCountBeforeResume + 1);
    expect(sessionManager.getEntries().at(-1)).toMatchObject({
      type: 'model_change',
      provider: alternateHighModel.provider,
      modelId: alternateHighModel.id,
    });
    resumed.dispose();
  });

  it('resumes only the selected branch', async () => {
    const sessionManager = SessionManager.inMemory();
    const gateway = createGateway([
      assistantStream(assistantMessage('B')),
      assistantStream(assistantMessage('C')),
      assistantStream(assistantMessage('D')),
    ]);
    const session = createAgentSession({ sessionManager, modelGateway: gateway, model });

    await session.prompt(userMessage('A'));
    await session.prompt(userMessage('C-input'));
    session.dispose();

    const assistantB = sessionManager
      .getEntries()
      .find(
        (entry) =>
          entry.type === 'message' &&
          entry.message.role === 'assistant' &&
          entry.message.content[0]?.type === 'text' &&
          entry.message.content[0].text === 'B',
      );
    if (assistantB === undefined || assistantB.type !== 'message')
      throw new Error('Assistant B not found.');

    sessionManager.branch(assistantB.id);
    const resumed = createAgentSession({
      sessionManager,
      modelGateway: createGateway([assistantStream(assistantMessage('D'))]),
    });

    expect(resumed.state.messages).toEqual([userMessage('A'), assistantMessage('B')]);

    await resumed.prompt(userMessage('D-input'));
    expect(sessionManager.buildSessionContext().messages).toEqual([
      userMessage('A'),
      assistantMessage('B'),
      userMessage('D-input'),
      assistantMessage('D'),
    ]);
    resumed.dispose();
  });
});
