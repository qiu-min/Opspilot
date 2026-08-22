import { describe, expect, it } from 'vitest';
import {
  createModelEventStream,
  type AssistantMessage,
  type FinishReason,
  type JsonObject,
  type Model,
  type ModelEventStream,
  type ModelToolCall,
} from '@opspilot/model-gateway';

import { Agent } from '../src/index.js';
import type { AgentMessage, AgentTool, StreamFn } from '../src/index.js';

const model: Model = {
  provider: 'test-provider',
  id: 'test-model',
  name: 'Test Model',
  api: 'test-api',
  baseUrl: 'https://model.example.test/v1',
  reasoning: false,
};

/** 创建测试用的用户消息。
 * @param text 消息文本。
 * @returns 一条 Agent 用户消息。
 */
function userMessage(text: string): AgentMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
  };
}

/** 创建模型返回的 assistant 消息。
 * @param finishReason 本次模型响应的结束原因。
 * @param toolCalls 本次模型请求执行的工具调用列表。
 * @returns 一条标准 assistant 消息。
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

/** 创建带文本增量的 assistant 事件流。
 * @param message 模型最终返回的 assistant 消息。
 * @param deltas 依次发送的文本增量。
 * @returns 可被 Agent 消费的模型事件流。
 */
function assistantStream(message: AssistantMessage, deltas: readonly string[] = []): ModelEventStream {
  return createModelEventStream(async (controller) => {
    const initial: AssistantMessage = { ...message, content: [], finishReason: 'pending' };
    controller.emit({ type: 'start', model, partial: initial });
    let text = '';
    for (const delta of deltas) {
      text += delta;
      controller.emit({
        type: 'text.delta',
        contentIndex: 0,
        delta,
        partial: { ...initial, content: [{ type: 'text', text }] },
      });
    }
    controller.complete(message);
  });
}

/** 创建按顺序返回模型流的函数。
 * @param streams 各次模型调用对应的事件流。
 * @returns 按调用顺序消费事件流的 StreamFn。
 */
function sequentialStreamFn(streams: readonly ModelEventStream[]): StreamFn {
  let index = 0;
  return () => {
    const stream = streams[index];
    index += 1;
    if (stream === undefined) throw new Error('Unexpected extra model call.');
    return stream;
  };
}

/** 创建固定文本结果的运行时工具。
 * @param name 工具名称。
 * @param text 工具返回的文本。
 * @returns 可被 Agent Loop 执行的测试工具。
 */
function textTool(name: string, text: string): AgentTool {
  return {
    name,
    description: `Test tool ${name}`,
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

/** 创建一个可由测试主动完成的异步通知。
 * @returns 包含等待 Promise 和完成函数的 deferred 对象。
 */
function createDeferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

describe('Agent real-time state', () => {
  it('initializes the mutable state from Agent options', () => {
    const history = [userMessage('history')];
    const tool = textTool('query_logs', 'logs');
    const agent = new Agent({
      model,
      messages: history,
      tools: [tool],
      streamFn: sequentialStreamFn([]),
    });

    expect(agent.state.messages).toEqual(history);
    expect(agent.state.tools).toEqual([tool]);
    expect(agent.state.model).toBe(model);
    expect(agent.state.isRunning).toBe(false);
    expect(agent.state.streamingMessage).toBeUndefined();
    expect(agent.state.errorMessage).toBeUndefined();
    expect(agent.state.pendingToolCalls).toEqual([]);
  });

  it('updates streamingMessage before notifying listeners and clears it at assistant end', async () => {
    const assistant = assistantMessage();
    const observedMessages: AgentMessage[] = [];
    let runningAtStart = false;
    let messageAtEnd: AgentMessage | undefined;
    const agent = new Agent({
      model,
      streamFn: sequentialStreamFn([assistantStream(assistant, ['hello', ' world'])]),
    });

    agent.subscribe((event) => {
      if (event.type === 'agent_start') runningAtStart = agent.state.isRunning;
      if (event.type === 'message_update' && event.event.type === 'text.delta') {
        observedMessages.push(agent.state.streamingMessage as AgentMessage);
      }
      if (event.type === 'message_end' && event.message === assistant) {
        messageAtEnd = agent.state.streamingMessage;
      }
    });

    await agent.prompt(userMessage('initial'));

    expect(runningAtStart).toBe(true);
    expect(
      observedMessages.map((message) => (message.role === 'assistant' ? message.content : undefined)),
    ).toEqual([
      [{ type: 'text', text: 'hello' }],
      [{ type: 'text', text: 'hello world' }],
    ]);
    expect(messageAtEnd).toBeUndefined();
    expect(agent.state.streamingMessage).toBeUndefined();
  });

  it('tracks cumulative thinking and partial tool calls as one streaming message', async () => {
    const call: ModelToolCall = { callId: 'call_1', name: 'query_logs', arguments: { service: 'payments' } };
    const startPartial = assistantMessage('pending');
    const thinkingSource = {
      api: model.api,
      provider: model.provider,
      model: model.id,
    };
    const firstThinking: AssistantMessage = {
      ...startPartial,
      content: [
        {
          type: 'thinking',
          thinking: 'first ',
          thinkingSignature: 'reasoning',
          source: thinkingSource,
        },
      ],
    };
    const secondThinking: AssistantMessage = {
      ...firstThinking,
      content: [
        {
          type: 'thinking',
          thinking: 'first second',
          thinkingSignature: 'reasoning',
          source: thinkingSource,
        },
      ],
    };
    const partialToolCall: AssistantMessage = {
      ...secondThinking,
      toolCalls: [{ callId: call.callId, name: call.name, arguments: { service: 'pay' } }],
    };
    const finalMessage = assistantMessage('stop', [call]);
    const observed: AgentMessage[] = [];
    const agent = new Agent({
      model,
      streamFn: () =>
        createModelEventStream(async (controller) => {
          controller.emit({ type: 'start', model, partial: startPartial });
          controller.emit({
            type: 'thinking.delta',
            contentIndex: 0,
            delta: 'first ',
            partial: firstThinking,
          });
          controller.emit({
            type: 'thinking.delta',
            contentIndex: 0,
            delta: 'second',
            partial: secondThinking,
          });
          controller.emit({
            type: 'tool-call.delta',
            contentIndex: 1,
            callId: call.callId,
            delta: '{"service":"pay',
            partial: partialToolCall,
          });
          controller.complete(finalMessage);
        }),
    });

    agent.subscribe((event) => {
      if (
        (event.type === 'message_start' || event.type === 'message_update') &&
        event.message.role === 'assistant'
      )
        observed.push(agent.state.streamingMessage as AgentMessage);
    });

    await agent.prompt(userMessage('initial'));

    expect(observed[0]).toEqual(startPartial);
    expect(observed[1]).toEqual(firstThinking);
    expect(observed[2]).toEqual(secondThinking);
    expect(observed[3]).toEqual(partialToolCall);
    expect(agent.state.streamingMessage).toBeUndefined();
    expect(agent.state.messages).toEqual([userMessage('initial'), finalMessage]);
  });

  it('commits the prompt message before the model run completes', async () => {
    const prompt = userMessage('blocked prompt');
    const started = createDeferred();
    const release = createDeferred();
    const agent = new Agent({
      model,
      streamFn: () =>
        createModelEventStream(async (controller) => {
          controller.emit({ type: 'start', model, partial: assistantMessage('pending') });
          started.resolve();
          await release.promise;
          controller.complete(assistantMessage());
        }),
    });

    const run = agent.prompt(prompt);
    await started.promise;

    expect(agent.state.messages).toEqual([prompt]);

    release.resolve();
    await run;
  });

  it('updates pendingToolCalls before tool listeners and removes them on completion', async () => {
    const call: ModelToolCall = {
      callId: 'call_1',
      name: 'query_logs',
      arguments: {},
    };
    const tool = textTool('query_logs', 'logs found');
    const assistant1 = assistantMessage('tool_calls' as FinishReason, [call]);
    const assistant2 = assistantMessage();
    let pendingAtStart: readonly ModelToolCall[] = [];
    let pendingAtEnd: readonly ModelToolCall[] = [];
    const agent = new Agent({
      model,
      tools: [tool],
      streamFn: sequentialStreamFn([assistantStream(assistant1), assistantStream(assistant2)]),
    });

    agent.subscribe((event) => {
      if (event.type === 'tool_execution_start') pendingAtStart = agent.state.pendingToolCalls;
      if (event.type === 'tool_execution_end') pendingAtEnd = agent.state.pendingToolCalls;
    });

    await agent.prompt(userMessage('initial'));

    expect(pendingAtStart).toEqual([call]);
    expect(pendingAtEnd).toEqual([]);
    expect(agent.state.pendingToolCalls).toEqual([]);
  });

  it('commits completed messages during the run without duplicating them', async () => {
    const history = userMessage('history');
    const prompt = userMessage('initial');
    const call: ModelToolCall = {
      callId: 'call_1',
      name: 'query_logs',
      arguments: {},
    };
    const tool = textTool('query_logs', 'logs found');
    const assistant1 = assistantMessage('tool_calls' as FinishReason, [call]);
    const assistant2 = assistantMessage();
    const messagesDuringRun: AgentMessage[][] = [];
    const agent = new Agent({
      model,
      messages: [history],
      tools: [tool],
      streamFn: sequentialStreamFn([assistantStream(assistant1), assistantStream(assistant2)]),
    });

    agent.subscribe((event) => {
      if (event.type === 'message_end' && event.message === assistant1) {
        messagesDuringRun.push([...agent.state.messages]);
      }
      if (event.type === 'message_end' && event.message.role === 'tool') {
        messagesDuringRun.push([...agent.state.messages]);
      }
    });

    const result = await agent.prompt(prompt);

    expect(messagesDuringRun).toEqual([
      [history, prompt, assistant1],
      [history, prompt, assistant1, result[2]],
    ]);
    expect(result).toHaveLength(4);
    expect(agent.state.messages).toEqual([history, ...result]);
  });

  it('preserves completed messages and clears transient state when a run fails', async () => {
    const history = userMessage('history');
    const failure: AssistantMessage = {
      ...assistantMessage('error'),
      content: [{ type: 'text', text: 'partial' }],
      errorMessage: 'model failed',
    };
    const agent = new Agent({
      model,
      messages: [history],
      streamFn: () =>
        createModelEventStream(async (controller) => {
          const partial = assistantMessage('pending');
          controller.emit({ type: 'start', model, partial });
          controller.emit({
            type: 'text.delta',
            contentIndex: 0,
            delta: 'partial',
            partial: { ...partial, content: [{ type: 'text', text: 'partial' }] },
          });
          controller.error(failure);
        }),
    });

    const prompt = userMessage('failed');
    await expect(agent.prompt(prompt)).resolves.toEqual([prompt, failure]);

    expect(agent.state.messages).toEqual([history, prompt, failure]);
    expect(agent.state.isRunning).toBe(false);
    expect(agent.state.streamingMessage).toBeUndefined();
    expect(agent.state.errorMessage).toBe('model failed');
    expect(agent.state.pendingToolCalls).toEqual([]);
  });

  it('reset clears transcript, queues and transient state', async () => {
    const history = userMessage('history');
    const agent = new Agent({
      model,
      messages: [history],
      streamFn: sequentialStreamFn([assistantStream(assistantMessage())]),
    });

    await agent.prompt(userMessage('run once'));
    agent.steer(userMessage('steering'));
    agent.followUp(userMessage('follow-up'));
    agent.reset();

    expect(agent.state.messages).toEqual([]);
    expect(agent.hasQueuedMessages()).toBe(false);
    expect(agent.state.streamingMessage).toBeUndefined();
    expect(agent.state.errorMessage).toBeUndefined();
    expect(agent.state.pendingToolCalls).toEqual([]);
    expect(agent.state.isRunning).toBe(false);
  });

  it('returns snapshots that cannot mutate internal arrays', async () => {
    const tool = textTool('query_logs', 'logs');
    const call: ModelToolCall = {
      callId: 'call_1',
      name: 'query_logs',
      arguments: {},
    };
    const assistant1 = assistantMessage('tool_calls' as FinishReason, [call]);
    const assistant2 = assistantMessage();
    const agent = new Agent({
      model,
      tools: [tool],
      streamFn: sequentialStreamFn([assistantStream(assistant1), assistantStream(assistant2)]),
    });

    agent.subscribe((event) => {
      if (event.type === 'tool_execution_start') {
        const snapshot = agent.state;
        (snapshot.messages as AgentMessage[]).push(userMessage('fake'));
        (snapshot.tools as AgentTool[]).length = 0;
        (snapshot.pendingToolCalls as ModelToolCall[]).length = 0;

        expect(agent.state.messages).toEqual([userMessage('initial'), assistant1]);
        expect(agent.state.tools).toEqual([tool]);
        expect(agent.state.pendingToolCalls).toEqual([call]);
      }
    });

    await agent.prompt(userMessage('initial'));
  });
});
