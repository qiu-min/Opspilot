import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage, AgentToolResult } from '@opspilot/agent-runtime';
import type {
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
  FileSystemSessionStore,
  RunConversationTurn,
  SessionManager,
  type SessionStore,
  type ToolDefinition,
} from '../src/index.js';

const directories: string[] = [];

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
): AgentMessage {
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

function createGateway(
  streams: readonly ModelEventStream[],
  registeredModels: readonly Model[] = [model],
  onStream?: () => void,
): ModelGateway & {
  readonly requestedModels: Model[];
  readonly requestedOptions: (Options | undefined)[];
  readonly stream: ReturnType<typeof vi.fn>;
} {
  let streamIndex = 0;
  const requestedModels: Model[] = [];
  const requestedOptions: (Options | undefined)[] = [];
  const stream = vi.fn((requestedModel: Model, _context: Context, options?: Options) => {
    requestedModels.push(requestedModel);
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
      throw new Error('complete is not used by this test.');
    },
    requestedModels,
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
  it('creates a session, runs a prompt, and persists only the turn messages', async () => {
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

    const result = await runner.execute({ message: userMessage('use lookup') });

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
});
