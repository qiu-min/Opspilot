import { describe, expect, it, vi } from 'vitest';
import {
  createModelEventStream,
  type AssistantMessage,
  type Context,
  type FinishReason,
  type JsonObject,
  type Message,
  type Model,
  type ModelEventStream,
  type ModelToolCall,
} from '@opspilot/model-gateway';

import { Agent, defaultConvertToLlm } from '../src/index.js';
import type { AgentEvent, AgentMessage, AgentTool, StreamFn } from '../src/index.js';

const model: Model = {
  provider: 'test-provider',
  id: 'test-model',
  name: 'Test Model',
  api: 'test-api',
  baseUrl: 'https://model.example.test/v1',
  reasoning: false,
};

/** 创建用户消息。
 * @param text 用户消息文本。
 */
function userMessage(text: string): AgentMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
  };
}

/** 创建模型返回的 assistant 消息。
 * @param finishReason 模型本次响应的结束原因。
 * @param toolCalls 模型本次请求执行的工具调用列表。
 */
function assistantMessage(
  finishReason: FinishReason = 'stop',
  toolCalls?: readonly ModelToolCall[],
): AssistantMessage {
  return {
    role: 'assistant',
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [],
    finishReason,
    ...(toolCalls === undefined ? {} : { toolCalls }),
  };
}

/** 创建完成一次模型响应的事件流。
 * @param message 模型最终返回的 assistant 消息。
 * @param delta 可选的文本增量。
 */
function assistantStream(message: AssistantMessage, delta?: string): ModelEventStream {
  return createModelEventStream(async (controller) => {
    const partial: AssistantMessage = { ...message, content: [], finishReason: 'pending' };
    controller.emit({ type: 'start', model, partial });
    if (delta !== undefined) {
      controller.emit({
        type: 'text.delta',
        contentIndex: 0,
        delta,
        partial: { ...partial, content: [{ type: 'text', text: delta }] },
      });
    }
    controller.complete(message);
  });
}

/** 创建按顺序返回模型事件流的函数。
 * @param streams 各次模型调用要返回的事件流。
 * @param contexts 记录传给模型的上下文。
 */
function sequentialStreamFn(
  streams: readonly ModelEventStream[],
  contexts: Context[] = [],
): StreamFn {
  let index = 0;
  return (_model, context) => {
    contexts.push(context);
    const stream = streams[index];
    index += 1;
    if (stream === undefined) throw new Error('Unexpected extra model call.');
    return stream;
  };
}

/** 创建固定结果的测试工具。
 * @param name 工具名称。
 * @param text 工具返回的文本。
 */
function textTool(name: string, text: string): AgentTool {
  return {
    name,
    description: 'Test tool',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    execute: async (_callId: string, _args: JsonObject, _signal?: AbortSignal) => ({
      content: [{ type: 'text', text }],
    }),
  };
}

describe('Agent', () => {
  it('runs one prompt and commits the returned messages', async () => {
    const prompt = userMessage('check the database');
    const assistant = assistantMessage();
    const agent = new Agent({
      model,
      streamFn: sequentialStreamFn([assistantStream(assistant)]),
    });

    const result = await agent.prompt(prompt);

    expect(result).toEqual([prompt, assistant]);
    expect(agent.state.messages).toEqual([prompt, assistant]);
    expect(agent.state.isRunning).toBe(false);
  });

  it('preserves history across prompts without duplicating the prompt', async () => {
    const firstPrompt = userMessage('first prompt');
    const firstAssistant = assistantMessage();
    const secondPrompt = userMessage('second prompt');
    const secondAssistant = assistantMessage();
    const contexts: Context[] = [];
    const agent = new Agent({
      model,
      streamFn: sequentialStreamFn(
        [assistantStream(firstAssistant), assistantStream(secondAssistant)],
        contexts,
      ),
    });

    await agent.prompt(firstPrompt);
    await agent.prompt(secondPrompt);

    expect(contexts[1]?.messages).toEqual([firstPrompt, firstAssistant, secondPrompt]);
    expect(agent.state.messages).toEqual([
      firstPrompt,
      firstAssistant,
      secondPrompt,
      secondAssistant,
    ]);
  });

  it('forwards the complete event sequence to subscribers', async () => {
    const prompt = userMessage('check the database');
    const assistant = assistantMessage();
    const events: AgentEvent[] = [];
    const agent = new Agent({
      model,
      streamFn: sequentialStreamFn([assistantStream(assistant, 'done')]),
    });

    agent.subscribe((event) => {
      events.push(event);
    });
    await agent.prompt(prompt);

    expect(events.map((event) => event.type)).toEqual([
      'agent_start',
      'turn_start',
      'message_start',
      'message_end',
      'message_start',
      'message_update',
      'message_end',
      'turn_end',
      'agent_end',
    ]);
    expect(events[2]).toEqual({ type: 'message_start', message: prompt });
    expect(events[3]).toEqual({ type: 'message_end', message: prompt });
    expect(events[6]).toEqual({ type: 'message_end', message: assistant });
  });

  it('stops delivering events after unsubscribe', async () => {
    const events: AgentEvent[] = [];
    const agent = new Agent({
      model,
      streamFn: sequentialStreamFn([assistantStream(assistantMessage()), assistantStream(assistantMessage())]),
    });

    const unsubscribe = agent.subscribe((event) => {
      events.push(event);
    });
    await agent.prompt(userMessage('first'));
    unsubscribe();
    const firstCount = events.length;
    await agent.prompt(userMessage('second'));

    expect(events).toHaveLength(firstCount);
  });

  it('awaits asynchronous subscribers before prompt resolves', async () => {
    const events: AgentEvent[] = [];
    const agent = new Agent({
      model,
      streamFn: sequentialStreamFn([assistantStream(assistantMessage())]),
    });

    agent.subscribe(async (event) => {
      await Promise.resolve();
      events.push(event);
    });
    await agent.prompt(userMessage('wait for listener'));

    expect(events).toHaveLength(8);
    expect(events.at(-1)?.type).toBe('agent_end');
  });

  it('rejects a concurrent prompt while one run is active', async () => {
    let release: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const agent = new Agent({
      model,
      streamFn: (_model, _context, options) =>
        createModelEventStream(async (controller) => {
          controller.emit({ type: 'start', model, partial: assistantMessage('pending') });
          markStarted?.();
          await new Promise<void>((resolve) => {
            release = resolve;
            options?.signal?.addEventListener('abort', () => resolve(), { once: true });
          });
          controller.complete(assistantMessage());
        }),
    });

    const firstRun = agent.prompt(userMessage('first'));
    await started;
    await expect(agent.prompt(userMessage('second'))).rejects.toThrow('Agent is already running.');
    release?.();
    await firstRun;
  });

  it('passes the Agent AbortSignal to streamFn and aborts the active run', async () => {
    let receivedSignal: AbortSignal | undefined;
    const failure: AssistantMessage = {
      ...assistantMessage('aborted'),
      errorMessage: 'Request aborted.',
    };
    const agent = new Agent({
      model,
      streamFn: (_model, _context, options) => {
        receivedSignal = options?.signal;
        return createModelEventStream(async (controller) => {
          controller.emit({ type: 'start', model, partial: assistantMessage('pending') });
          await new Promise<void>((resolve) => {
            if (receivedSignal?.aborted) {
              resolve();
              return;
            }
            receivedSignal?.addEventListener('abort', () => resolve(), { once: true });
          });
          controller.error(failure);
        });
      },
    });

    const run = agent.prompt(userMessage('abort this'));
    while (receivedSignal === undefined) await Promise.resolve();
    agent.abort();

    await expect(run).resolves.toEqual([userMessage('abort this'), failure]);
    expect(receivedSignal?.aborted).toBe(true);
    expect(agent.state.isRunning).toBe(false);
  });

  it('clears running state after failure and allows a later prompt', async () => {
    const failure: AssistantMessage = {
      ...assistantMessage('error'),
      errorMessage: 'model failed',
    };
    const agent = new Agent({
      model,
      streamFn: sequentialStreamFn([
        createModelEventStream(async (controller) => {
          controller.error(failure);
        }),
        assistantStream(assistantMessage()),
      ]),
    });

    await expect(agent.prompt(userMessage('failed prompt'))).resolves.toEqual([
      userMessage('failed prompt'),
      failure,
    ]);
    expect(agent.state.isRunning).toBe(false);
    await expect(agent.prompt(userMessage('retry prompt'))).resolves.toHaveLength(2);
    expect(agent.state.errorMessage).toBeUndefined();
  });

  it('preserves completed messages when a run fails', async () => {
    const history = [userMessage('history')];
    const failure: AssistantMessage = {
      ...assistantMessage('error'),
      errorMessage: 'tool failed',
    };
    const agent = new Agent({
      model,
      messages: history,
      streamFn: () =>
        createModelEventStream(async (controller) => {
          controller.error(failure);
        }),
    });

    await expect(agent.prompt(userMessage('new prompt'))).resolves.toEqual([
      userMessage('new prompt'),
      failure,
    ]);

    expect(agent.state.messages).toEqual([...history, userMessage('new prompt'), failure]);
    expect(agent.state.errorMessage).toBe('tool failed');
  });

  it('resets messages but keeps configuration and rejects reset while running', async () => {
    const tool = textTool('query_logs', 'logs');
    const firstAgent = new Agent({
      model,
      systemPrompt: 'system',
      tools: [tool],
      streamFn: sequentialStreamFn([assistantStream(assistantMessage())]),
    });
    await firstAgent.prompt(userMessage('run once'));
    firstAgent.reset();

    expect(firstAgent.state.messages).toEqual([]);
    expect(firstAgent.state.model).toBe(model);
    expect(firstAgent.state.systemPrompt).toBe('system');
    expect(firstAgent.state.tools).toEqual([tool]);

    let release: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const runningAgent = new Agent({
      model,
      streamFn: () =>
        createModelEventStream(async (controller) => {
          controller.emit({ type: 'start', model, partial: assistantMessage('pending') });
          markStarted?.();
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          controller.complete(assistantMessage());
        }),
    });
    const run = runningAgent.prompt(userMessage('running'));
    await started;
    expect(() => runningAgent.reset()).toThrow('Cannot reset while Agent is running.');
    release?.();
    await run;
  });

  it('returns state snapshots without exposing mutable arrays', async () => {
    const prompt = userMessage('snapshot');
    const tool = textTool('query_logs', 'logs');
    const agent = new Agent({
      model,
      tools: [tool],
      streamFn: sequentialStreamFn([assistantStream(assistantMessage())]),
    });

    await agent.prompt(prompt);
    const state = agent.state;
    const messages = [...state.messages];
    const tools = [...state.tools];
    messages.length = 0;
    tools.length = 0;

    expect(agent.state.messages).toEqual([prompt, agent.state.messages[1]]);
    expect(agent.state.tools).toEqual([tool]);
  });

  it('passes transformContext, convertToLlm and shouldStopAfterTurn through the real loop', async () => {
    const prompt = userMessage('use hooks');
    const assistant = assistantMessage();
    const transformed = [prompt];
    const transformedInputs: AgentMessage[][] = [];
    const transformContext = vi.fn((messages: readonly AgentMessage[]) => {
      transformedInputs.push([...messages]);
      return transformed;
    });
    const converted: AgentMessage[][] = [];
    const convertToLlm = vi.fn((messages: readonly AgentMessage[]): readonly Message[] => {
      converted.push([...messages]);
      return defaultConvertToLlm(messages);
    });
    const shouldStopAfterTurn = vi.fn(() => true);
    const contexts: Context[] = [];
    const agent = new Agent({
      model,
      transformContext,
      convertToLlm,
      shouldStopAfterTurn,
      streamFn: sequentialStreamFn([assistantStream(assistant)], contexts),
    });

    await agent.prompt(prompt);

    expect(transformedInputs).toEqual([[prompt]]);
    expect(converted).toEqual([transformed]);
    expect(contexts[0]?.messages).toEqual([prompt]);
    expect(shouldStopAfterTurn).toHaveBeenCalledTimes(1);
  });
});
