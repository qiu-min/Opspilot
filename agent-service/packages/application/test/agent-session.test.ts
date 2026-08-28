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

import { createAgentSession, SessionManager } from '../src/index.js';

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

function assistantStream(message: AssistantMessage): ModelEventStream {
  return createModelEventStream(async (controller) => {
    controller.emit({
      type: 'start',
      model,
      partial: { ...message, content: [], finishReason: 'pending' },
    });
    controller.complete(message);
  });
}

function createGateway(streams: readonly ModelEventStream[]): ModelGateway & {
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
    getModels: () => [model],
    getModel: (provider, id) =>
      provider === model.provider && id === model.id ? model : undefined,
    stream,
    complete: async () => {
      throw new Error('complete is not used by this test.');
    },
  };
}

function messageEntries(sessionManager: SessionManager): AgentMessage[] {
  return sessionManager
    .getEntries()
    .filter((entry) => entry.type === 'message')
    .map((entry) => entry.message);
}

describe('AgentSession composition and persistence', () => {
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

  it('persists tool results once through message_end and stops persisting after dispose', async () => {
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
      assistantStream(assistantMessage('not persisted')),
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
    await session.prompt(userMessage('after dispose'));

    expect(messageEntries(sessionManager).map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
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
