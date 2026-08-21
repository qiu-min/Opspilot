import { describe, expect, it, vi } from 'vitest';
import {
  createModelEventStream,
  type AssistantMessage,
  type Context,
  type FinishReason,
  type JsonObject,
  type Model,
  type ModelEventStream,
  type ModelToolCall,
} from '@opspilot/model-gateway';

import { Agent, runAgentLoop } from '../src/index.js';
import type {
  AgentContext,
  AgentEvent,
  AgentMessage,
  AgentTool,
  StreamFn,
} from '../src/index.js';

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

/** 创建只返回一条 assistant 消息的模型事件流。
 * @param message 本次模型响应的 assistant 消息。
 * @returns 可被 Agent Loop 消费的模型事件流。
 */
function assistantStream(message: AssistantMessage): ModelEventStream {
  return createModelEventStream(async (controller) => {
    controller.emit({ type: 'start', model });
    controller.complete(message);
  });
}

/** 创建按顺序返回模型响应并记录上下文的 streamFn。
 * @param streams 各次模型调用对应的事件流。
 * @param contexts 用于记录传给模型的上下文。
 * @param signals 用于记录传给模型的取消信号。
 * @returns 按调用顺序消费事件流的模型流函数。
 */
function sequentialStreamFn(
  streams: readonly ModelEventStream[],
  contexts: Context[],
  signals: (AbortSignal | undefined)[] = [],
): StreamFn {
  let index = 0;
  return (_model, context, options) => {
    contexts.push(context);
    signals.push(options?.signal);
    const stream = streams[index];
    index += 1;
    if (stream === undefined) throw new Error('Unexpected extra model call.');
    return stream;
  };
}

/** 创建一份不共享消息数组的 Agent 上下文。
 * @param tools 本次运行允许使用的工具列表。
 * @returns 初始为空的 Agent 上下文。
 */
function createContext(tools?: readonly AgentTool[]): AgentContext {
  return {
    messages: [],
    ...(tools === undefined ? {} : { tools }),
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

describe('steering and follow-up loop', () => {
  it('injects steering after a completed tool turn and returns it in newMessages', async () => {
    const prompt = userMessage('initial');
    const steering = userMessage('steering');
    const call: ModelToolCall = {
      callId: 'call_1',
      name: 'query_logs',
      arguments: {},
    };
    const assistant1 = assistantMessage('tool_calls', [call]);
    const assistant2 = assistantMessage('stop');
    const tool = textTool('query_logs', 'logs found');
    const contexts: Context[] = [];
    const events: AgentEvent[] = [];
    const getSteeringMessages = vi
      .fn<() => readonly AgentMessage[]>()
      .mockReturnValueOnce([])
      .mockReturnValueOnce([steering])
      .mockReturnValue([]);
    const getFollowUpMessages = vi.fn(() => []);

    const result = await runAgentLoop(
      [prompt],
      createContext([tool]),
      {
        model,
        getSteeringMessages,
        getFollowUpMessages,
      },
      sequentialStreamFn([assistantStream(assistant1), assistantStream(assistant2)], contexts),
      (event) => {
        events.push(event);
      },
    );

    const toolResult = result[2];
    expect(contexts[1]?.messages).toEqual([prompt, assistant1, toolResult, steering]);
    expect(result).toEqual([prompt, assistant1, toolResult, steering, assistant2]);
    expect(getSteeringMessages).toHaveBeenCalledTimes(3);
    expect(getFollowUpMessages).toHaveBeenCalledTimes(1);
  });

  it('continues after a stop response when steering is available', async () => {
    const prompt = userMessage('initial');
    const steering = userMessage('continue this investigation');
    const assistant1 = assistantMessage('stop');
    const assistant2 = assistantMessage('stop');
    const contexts: Context[] = [];
    const getSteeringMessages = vi
      .fn<() => readonly AgentMessage[]>()
      .mockReturnValueOnce([])
      .mockReturnValueOnce([steering])
      .mockReturnValue([]);
    const events: AgentEvent[] = [];

    const result = await runAgentLoop(
      [prompt],
      createContext(),
      { model, getSteeringMessages, getFollowUpMessages: () => [] },
      sequentialStreamFn([assistantStream(assistant1), assistantStream(assistant2)], contexts),
      (event) => {
        events.push(event);
      },
    );

    expect(contexts[1]?.messages).toEqual([prompt, assistant1, steering]);
    expect(result).toEqual([prompt, assistant1, steering, assistant2]);
    expect(events.filter((event) => event.type === 'agent_start')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'agent_end')).toHaveLength(1);
  });

  it('injects follow-up only after active work naturally ends', async () => {
    const prompt = userMessage('initial');
    const followUp = userMessage('follow-up');
    const call: ModelToolCall = {
      callId: 'call_1',
      name: 'query_logs',
      arguments: {},
    };
    const assistant1 = assistantMessage('tool_calls', [call]);
    const assistant2 = assistantMessage('stop');
    const assistant3 = assistantMessage('stop');
    const tool = textTool('query_logs', 'logs found');
    const contexts: Context[] = [];
    const events: AgentEvent[] = [];
    const pollOrder: string[] = [];
    const getSteeringMessages = vi.fn(() => {
      pollOrder.push('steering');
      return [];
    });
    const getFollowUpMessages = vi
      .fn<() => readonly AgentMessage[]>()
      .mockImplementationOnce(() => {
        pollOrder.push('follow-up');
        return [followUp];
      })
      .mockImplementation(() => {
        pollOrder.push('follow-up');
        return [];
      });

    const result = await runAgentLoop(
      [prompt],
      createContext([tool]),
      { model, getSteeringMessages, getFollowUpMessages },
      sequentialStreamFn(
        [assistantStream(assistant1), assistantStream(assistant2), assistantStream(assistant3)],
        contexts,
      ),
      (event) => {
        events.push(event);
      },
    );

    expect(pollOrder).toEqual(['steering', 'steering', 'steering', 'follow-up', 'steering', 'follow-up']);
    expect(contexts[1]?.messages).toEqual([prompt, assistant1, result[2]]);
    expect(contexts[2]?.messages).toEqual([prompt, assistant1, result[2], assistant2, followUp]);
    expect(result).toEqual([prompt, assistant1, result[2], assistant2, followUp, assistant3]);
    const followUpStart = events.findIndex(
      (event) => event.type === 'message_start' && event.message === followUp,
    );
    expect(events[followUpStart - 1]).toEqual({ type: 'turn_start' });
    expect(events[followUpStart + 1]).toEqual({ type: 'message_end', message: followUp });
  });

  it('emits pending message events after turn_start and before the next assistant', async () => {
    const prompt = userMessage('initial');
    const steering = userMessage('steering');
    const assistant1 = assistantMessage('stop');
    const assistant2 = assistantMessage('stop');
    const events: AgentEvent[] = [];
    const getSteeringMessages = vi
      .fn<() => readonly AgentMessage[]>()
      .mockReturnValueOnce([])
      .mockReturnValueOnce([steering])
      .mockReturnValue([]);

    await runAgentLoop(
      [prompt],
      createContext(),
      { model, getSteeringMessages, getFollowUpMessages: () => [] },
      sequentialStreamFn([assistantStream(assistant1), assistantStream(assistant2)], []),
      (event) => {
        events.push(event);
      },
    );

    const steeringStart = events.findIndex(
      (event) => event.type === 'message_start' && event.message === steering,
    );
    const steeringEnd = events.findIndex(
      (event) => event.type === 'message_end' && event.message === steering,
    );
    expect(events[steeringStart - 1]).toEqual({ type: 'turn_start' });
    expect(steeringEnd).toBe(steeringStart + 1);
    expect(events[steeringEnd + 1]).toEqual({ type: 'message_start' });
  });

  it('keeps multiple steering and follow-up messages FIFO in context and newMessages', async () => {
    const prompt = userMessage('initial');
    const steering = [userMessage('steering A'), userMessage('steering B')];
    const followUp = [userMessage('follow-up A'), userMessage('follow-up B')];
    const assistant1 = assistantMessage('stop');
    const assistant2 = assistantMessage('stop');
    const assistant3 = assistantMessage('stop');
    const contexts: Context[] = [];
    const getSteeringMessages = vi
      .fn<() => readonly AgentMessage[]>()
      .mockReturnValueOnce([])
      .mockReturnValueOnce(steering)
      .mockReturnValue([]);
    const getFollowUpMessages = vi
      .fn<() => readonly AgentMessage[]>()
      .mockReturnValueOnce(followUp)
      .mockReturnValue([]);

    const result = await runAgentLoop(
      [prompt],
      createContext(),
      { model, getSteeringMessages, getFollowUpMessages },
      sequentialStreamFn(
        [assistantStream(assistant1), assistantStream(assistant2), assistantStream(assistant3)],
        contexts,
      ),
      () => undefined,
    );

    expect(contexts[1]?.messages).toEqual([prompt, assistant1, ...steering]);
    expect(contexts[2]?.messages).toEqual([prompt, assistant1, ...steering, assistant2, ...followUp]);
    expect(result).toEqual([prompt, assistant1, ...steering, assistant2, ...followUp, assistant3]);
    expect(getFollowUpMessages).toHaveBeenCalledTimes(2);
  });

  it('polls follow-up only after shouldStopAfterTurn allows continuation', async () => {
    const getSteeringMessages = vi.fn(() => []);
    const getFollowUpMessages = vi.fn(() => [userMessage('must not run')]);
    const events: AgentEvent[] = [];

    await runAgentLoop(
      [userMessage('initial')],
      createContext(),
      {
        model,
        getSteeringMessages,
        getFollowUpMessages,
        shouldStopAfterTurn: () => true,
      },
      sequentialStreamFn([assistantStream(assistantMessage())], []),
      (event) => {
        events.push(event);
      },
    );

    expect(getSteeringMessages).toHaveBeenCalledTimes(1);
    expect(getFollowUpMessages).not.toHaveBeenCalled();
    expect(events.at(-1)?.type).toBe('agent_end');
  });

  it('does not poll follow-up while a tool call requires another turn', async () => {
    const call: ModelToolCall = {
      callId: 'call_1',
      name: 'query_logs',
      arguments: {},
    };
    const getFollowUpMessages = vi.fn(() => []);
    const tool = textTool('query_logs', 'logs found');

    await runAgentLoop(
      [userMessage('initial')],
      createContext([tool]),
      { model, getSteeringMessages: () => [], getFollowUpMessages },
      sequentialStreamFn(
        [assistantStream(assistantMessage('tool_calls', [call])), assistantStream(assistantMessage())],
        [],
      ),
      () => undefined,
    );

    expect(getFollowUpMessages).toHaveBeenCalledTimes(1);
  });

  it('passes the same AbortSignal to steering and follow-up callbacks', async () => {
    const controller = new AbortController();
    const steeringSignals: (AbortSignal | undefined)[] = [];
    const followUpSignals: (AbortSignal | undefined)[] = [];
    const getSteeringMessages = vi.fn((signal?: AbortSignal) => {
      steeringSignals.push(signal);
      return [];
    });
    const getFollowUpMessages = vi.fn((signal?: AbortSignal) => {
      followUpSignals.push(signal);
      return [];
    });

    await runAgentLoop(
      [userMessage('initial')],
      createContext(),
      { model, getSteeringMessages, getFollowUpMessages },
      sequentialStreamFn([assistantStream(assistantMessage())], [], []),
      () => undefined,
      controller.signal,
    );

    expect(steeringSignals).toEqual([controller.signal, controller.signal]);
    expect(followUpSignals).toEqual([controller.signal]);
  });

  it('keeps Agent queues when shouldStopAfterTurn stops before polling them', async () => {
    const steering = userMessage('steering');
    const followUp = userMessage('follow-up');
    let agent: Agent | undefined;
    agent = new Agent({
      model,
      shouldStopAfterTurn: () => true,
      streamFn: () => {
        agent?.steer(steering);
        agent?.followUp(followUp);
        return assistantStream(assistantMessage());
      },
    });

    await agent.prompt(userMessage('initial'));

    expect(agent.hasQueuedMessages()).toBe(true);
  });
});
