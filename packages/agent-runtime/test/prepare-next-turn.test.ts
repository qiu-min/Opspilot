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
  AgentMessage,
  AgentTool,
  PrepareNextTurnContext,
  StreamFn,
} from '../src/index.js';

const modelA: Model = {
  provider: 'test-provider',
  id: 'model-a',
  name: 'Model A',
  api: 'test-api',
  baseUrl: 'https://model.example.test/v1',
  reasoning: false,
};

const modelB: Model = {
  ...modelA,
  id: 'model-b',
  name: 'Model B',
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
 * @param model 响应该消息的模型。
 * @param finishReason 本次模型响应的结束原因。
 * @param toolCalls 本次模型请求执行的工具调用列表。
 * @returns 一条标准 assistant 消息。
 */
function assistantMessage(
  model: Model = modelA,
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
 * @param streamModel 模型流开始事件中的模型。
 * @returns 可被 Agent Loop 消费的模型事件流。
 */
function assistantStream(
  message: AssistantMessage,
  streamModel: Model = modelA,
): ModelEventStream {
  return createModelEventStream(async (controller) => {
    controller.emit({
      type: 'start',
      model: streamModel,
      partial: { ...message, content: [], finishReason: 'pending' },
    });
    controller.complete(message);
  });
}

/** 创建按顺序返回模型响应并记录模型和上下文的 streamFn。
 * @param streams 各次模型调用对应的事件流。
 * @param models 记录每次调用实际使用的模型。
 * @param contexts 记录每次调用收到的上下文。
 * @returns 按调用顺序消费事件流的模型流函数。
 */
function sequentialStreamFn(
  streams: readonly ModelEventStream[],
  models: Model[],
  contexts: Context[],
): StreamFn {
  let index = 0;
  return (model, context) => {
    models.push(model);
    contexts.push(context);
    const stream = streams[index];
    index += 1;
    if (stream === undefined) throw new Error('Unexpected extra model call.');
    return stream;
  };
}

/** 创建一份不共享消息数组的 Agent 上下文。
 * @param messages 初始运行消息。
 * @param tools 本次运行允许使用的工具列表。
 * @returns 初始 Agent 上下文。
 */
function createContext(
  messages: readonly AgentMessage[] = [],
  tools?: readonly AgentTool[],
): AgentContext {
  return {
    messages: [...messages],
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

/** 创建一个需要工具执行后再进入下一 Turn 的模型响应序列。
 * @param firstAssistant 第一 Turn 的 assistant 消息。
 * @param secondAssistant 第二 Turn 的 assistant 消息。
 * @returns 两次模型调用对应的事件流。
 */
function twoTurnStreams(
  firstAssistant: AssistantMessage,
  secondAssistant: AssistantMessage,
): readonly ModelEventStream[] {
  return [assistantStream(firstAssistant), assistantStream(secondAssistant)];
}

describe('prepareNextTurn', () => {
  it('keeps the previous behavior when the hook is not configured', async () => {
    const prompt = userMessage('initial');
    const assistant = assistantMessage();
    const result = await runAgentLoop(
      [prompt],
      createContext(),
      { model: modelA },
      sequentialStreamFn([assistantStream(assistant)], [], []),
      () => undefined,
    );

    expect(result).toEqual([prompt, assistant]);
  });

  it('calls prepareNextTurn once after every complete Turn', async () => {
    const call: ModelToolCall = {
      callId: 'call_1',
      name: 'query_logs',
      arguments: {},
    };
    const tool = textTool('query_logs', 'logs found');
    const firstAssistant = assistantMessage(modelA, 'tool_calls', [call]);
    const secondAssistant = assistantMessage();
    const prepareNextTurn = vi.fn(() => undefined);

    await runAgentLoop(
      [userMessage('initial')],
      createContext([], [tool]),
      {
        model: modelA,
        prepareNextTurn,
        getSteeringMessages: () => [],
        getFollowUpMessages: () => [],
      },
      sequentialStreamFn(twoTurnStreams(firstAssistant, secondAssistant), [], []),
      () => undefined,
    );

    expect(prepareNextTurn).toHaveBeenCalledTimes(2);
  });

  it('receives the completed assistant, tool results, context and newMessages', async () => {
    const prompt = userMessage('initial');
    const call: ModelToolCall = {
      callId: 'call_1',
      name: 'query_logs',
      arguments: {},
    };
    const tool = textTool('query_logs', 'logs found');
    const assistant = assistantMessage(modelA, 'tool_calls', [call]);
    const prepareNextTurn = vi.fn((_context: PrepareNextTurnContext) => undefined);

    const result = await runAgentLoop(
      [prompt],
      createContext([], [tool]),
      { model: modelA, prepareNextTurn, shouldStopAfterTurn: () => true },
      sequentialStreamFn([assistantStream(assistant)], [], []),
      () => undefined,
    );

    const toolResult = result[2];
    const hookContext = prepareNextTurn.mock.calls[0]?.[0];
    expect(hookContext?.message).toBe(assistant);
    expect(hookContext?.toolResults).toEqual([toolResult]);
    expect(hookContext?.context.messages).toEqual([prompt, assistant, toolResult]);
    expect(hookContext?.newMessages).toEqual([prompt, assistant, toolResult]);
  });

  it('uses a model update on the next model call', async () => {
    const call: ModelToolCall = {
      callId: 'call_1',
      name: 'query_logs',
      arguments: {},
    };
    const tool = textTool('query_logs', 'logs found');
    const firstAssistant = assistantMessage(modelA, 'tool_calls', [call]);
    const secondAssistant = assistantMessage(modelB);
    const models: Model[] = [];
    const prepareNextTurn = vi.fn(({ message }: PrepareNextTurnContext) => {
      if (message === firstAssistant) return { model: modelB };
      return undefined;
    });

    await runAgentLoop(
      [userMessage('initial')],
      createContext([], [tool]),
      {
        model: modelA,
        prepareNextTurn,
        getSteeringMessages: () => [],
        getFollowUpMessages: () => [],
      },
      sequentialStreamFn(twoTurnStreams(firstAssistant, secondAssistant), models, []),
      () => undefined,
    );

    expect(models).toEqual([modelA, modelB]);
  });

  it('keeps the original model when prepareNextTurn returns undefined', async () => {
    const call: ModelToolCall = {
      callId: 'call_1',
      name: 'query_logs',
      arguments: {},
    };
    const tool = textTool('query_logs', 'logs found');
    const models: Model[] = [];

    await runAgentLoop(
      [userMessage('initial')],
      createContext([], [tool]),
      {
        model: modelA,
        prepareNextTurn: () => undefined,
        getSteeringMessages: () => [],
        getFollowUpMessages: () => [],
      },
      sequentialStreamFn(
        twoTurnStreams(assistantMessage(modelA, 'tool_calls', [call]), assistantMessage()),
        models,
        [],
      ),
      () => undefined,
    );

    expect(models).toEqual([modelA, modelA]);
  });

  it('replaces context for the next model call without merging it automatically', async () => {
    const call: ModelToolCall = {
      callId: 'call_1',
      name: 'query_logs',
      arguments: {},
    };
    const tool = textTool('query_logs', 'logs found');
    const replacement = userMessage('compacted context');
    const firstAssistant = assistantMessage(modelA, 'tool_calls', [call]);
    const secondAssistant = assistantMessage();
    const contexts: Context[] = [];
    const prepareNextTurn = vi.fn(({ message, context }: PrepareNextTurnContext) => {
      if (message === firstAssistant) {
        return {
          context: {
            ...context,
            messages: [replacement],
          },
        };
      }
      return undefined;
    });

    await runAgentLoop(
      [userMessage('initial')],
      createContext([], [tool]),
      {
        model: modelA,
        prepareNextTurn,
        getSteeringMessages: () => [],
        getFollowUpMessages: () => [],
      },
      sequentialStreamFn(twoTurnStreams(firstAssistant, secondAssistant), [], contexts),
      () => undefined,
    );

    expect(contexts[1]?.messages).toEqual([replacement]);
  });

  it('keeps newMessages independent from a replaced runtime context', async () => {
    const prompt = userMessage('initial');
    const call: ModelToolCall = {
      callId: 'call_1',
      name: 'query_logs',
      arguments: {},
    };
    const tool = textTool('query_logs', 'logs found');
    const replacement = userMessage('compacted context');
    const firstAssistant = assistantMessage(modelA, 'tool_calls', [call]);
    const secondAssistant = assistantMessage();
    const prepareNextTurn = vi.fn(({ message, context }: PrepareNextTurnContext) => {
      if (message === firstAssistant) {
        return { context: { ...context, messages: [replacement] } };
      }
      return undefined;
    });

    const result = await runAgentLoop(
      [prompt],
      createContext([], [tool]),
      {
        model: modelA,
        prepareNextTurn,
        getSteeringMessages: () => [],
        getFollowUpMessages: () => [],
      },
      sequentialStreamFn(twoTurnStreams(firstAssistant, secondAssistant), [], []),
      () => undefined,
    );

    expect(result).toEqual([prompt, firstAssistant, result[2], secondAssistant]);
    expect(result).not.toContain(replacement);
  });

  it('applies model and context updates together', async () => {
    const call: ModelToolCall = {
      callId: 'call_1',
      name: 'query_logs',
      arguments: {},
    };
    const tool = textTool('query_logs', 'logs found');
    const replacement = userMessage('next context');
    const firstAssistant = assistantMessage(modelA, 'tool_calls', [call]);
    const secondAssistant = assistantMessage(modelB);
    const models: Model[] = [];
    const contexts: Context[] = [];
    const prepareNextTurn = vi.fn(({ message, context }: PrepareNextTurnContext) => {
      if (message === firstAssistant) {
        return {
          model: modelB,
          context: { ...context, messages: [replacement] },
        };
      }
      return undefined;
    });

    await runAgentLoop(
      [userMessage('initial')],
      createContext([], [tool]),
      {
        model: modelA,
        prepareNextTurn,
        getSteeringMessages: () => [],
        getFollowUpMessages: () => [],
      },
      sequentialStreamFn(twoTurnStreams(firstAssistant, secondAssistant), models, contexts),
      () => undefined,
    );

    expect(models).toEqual([modelA, modelB]);
    expect(contexts[1]?.messages).toEqual([replacement]);
  });

  it('runs prepare before shouldStop and gives shouldStop the updated context', async () => {
    const updatedContext = createContext([userMessage('updated')]);
    const order: string[] = [];
    let receivedContext: AgentContext | undefined;
    const assistant = assistantMessage();

    await runAgentLoop(
      [userMessage('initial')],
      createContext(),
      {
        model: modelA,
        prepareNextTurn: () => {
          order.push('prepare');
          return { context: updatedContext };
        },
        shouldStopAfterTurn: ({ context }) => {
          order.push('stop');
          receivedContext = context;
          return true;
        },
      },
      sequentialStreamFn([assistantStream(assistant)], [], []),
      () => undefined,
    );

    expect(order).toEqual(['prepare', 'stop']);
    expect(receivedContext).toBe(updatedContext);
  });

  it('runs steering polling after prepare and shouldStop', async () => {
    const order: string[] = [];
    let steeringPollCount = 0;
    const getSteeringMessages = vi.fn(() => {
      steeringPollCount += 1;
      if (steeringPollCount > 1) order.push('steering');
      return [];
    });

    await runAgentLoop(
      [userMessage('initial')],
      createContext(),
      {
        model: modelA,
        prepareNextTurn: () => {
          order.push('prepare');
          return undefined;
        },
        shouldStopAfterTurn: () => {
          order.push('stop');
          return false;
        },
        getSteeringMessages,
        getFollowUpMessages: () => [],
      },
      sequentialStreamFn([assistantStream(assistantMessage())], [], []),
      () => undefined,
    );

    expect(order).toEqual(['prepare', 'stop', 'steering']);
  });

  it('injects steering into the updated context', async () => {
    const steering = userMessage('steering');
    const replacement = userMessage('updated context');
    const firstAssistant = assistantMessage();
    const secondAssistant = assistantMessage();
    const contexts: Context[] = [];
    let steeringPollCount = 0;
    const getSteeringMessages = vi.fn(() => {
      steeringPollCount += 1;
      return steeringPollCount === 2 ? [steering] : [];
    });
    const prepareNextTurn = vi.fn(({ message, context }: PrepareNextTurnContext) => {
      if (message === firstAssistant) return { context: { ...context, messages: [replacement] } };
      return undefined;
    });

    await runAgentLoop(
      [userMessage('initial')],
      createContext(),
      {
        model: modelA,
        prepareNextTurn,
        getSteeringMessages,
        getFollowUpMessages: () => [],
      },
      sequentialStreamFn([assistantStream(firstAssistant), assistantStream(secondAssistant)], [], contexts),
      () => undefined,
    );

    expect(contexts[1]?.messages).toEqual([replacement, steering]);
  });

  it('injects follow-up into the latest updated context', async () => {
    const followUp = userMessage('follow-up');
    const replacement = userMessage('updated context');
    const firstAssistant = assistantMessage();
    const secondAssistant = assistantMessage();
    const contexts: Context[] = [];
    const prepareNextTurn = vi.fn(({ message, context }: PrepareNextTurnContext) => {
      if (message === firstAssistant) return { context: { ...context, messages: [replacement] } };
      return undefined;
    });
    const getFollowUpMessages = vi
      .fn<() => readonly AgentMessage[]>()
      .mockReturnValueOnce([followUp])
      .mockReturnValue([]);

    await runAgentLoop(
      [userMessage('initial')],
      createContext(),
      {
        model: modelA,
        prepareNextTurn,
        getSteeringMessages: () => [],
        getFollowUpMessages,
      },
      sequentialStreamFn([assistantStream(firstAssistant), assistantStream(secondAssistant)], [], contexts),
      () => undefined,
    );

    expect(contexts[1]?.messages).toEqual([replacement, followUp]);
  });

  it('does not create a new Turn just because the model was updated', async () => {
    const models: Model[] = [];
    const prepareNextTurn = vi.fn(() => ({ model: modelB }));

    await runAgentLoop(
      [userMessage('initial')],
      createContext(),
      {
        model: modelA,
        prepareNextTurn,
        getSteeringMessages: () => [],
        getFollowUpMessages: () => [],
      },
      sequentialStreamFn([assistantStream(assistantMessage())], models, []),
      () => undefined,
    );

    expect(prepareNextTurn).toHaveBeenCalledTimes(1);
    expect(models).toEqual([modelA]);
  });

  it('passes the same AbortSignal to prepareNextTurn', async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;

    await runAgentLoop(
      [userMessage('initial')],
      createContext(),
      {
        model: modelA,
        prepareNextTurn: (_context, signal) => {
          receivedSignal = signal;
          return undefined;
        },
      },
      sequentialStreamFn([assistantStream(assistantMessage())], [], []),
      () => undefined,
      controller.signal,
    );

    expect(receivedSignal).toBe(controller.signal);
  });

  it('passes AgentOptions.prepareNextTurn through the real Agent', async () => {
    const call: ModelToolCall = {
      callId: 'call_1',
      name: 'query_logs',
      arguments: {},
    };
    const tool = textTool('query_logs', 'logs found');
    const prepareNextTurn = vi.fn(() => undefined);
    const agent = new Agent({
      model: modelA,
      tools: [tool],
      prepareNextTurn,
      streamFn: sequentialStreamFn(
        twoTurnStreams(
          assistantMessage(modelA, 'tool_calls', [call]),
          assistantMessage(),
        ),
        [],
        [],
      ),
    });

    await agent.prompt(userMessage('initial'));

    expect(prepareNextTurn).toHaveBeenCalledTimes(2);
  });

  it('uses the active run model for a runtime failure after prepareNextTurn switches models', async () => {
    const call: ModelToolCall = {
      callId: 'call_1',
      name: 'query_logs',
      arguments: {},
    };
    const firstAssistant = assistantMessage(modelA, 'tool_calls', [call]);
    const models: Model[] = [];
    let transformCallCount = 0;
    const agent = new Agent({
      model: modelA,
      tools: [textTool('query_logs', 'logs found')],
      transformContext: (messages) => {
        transformCallCount += 1;
        if (transformCallCount === 2) throw new Error('second turn runtime failed');
        return messages;
      },
      prepareNextTurn: () => ({ model: modelB }),
      streamFn: sequentialStreamFn([assistantStream(firstAssistant)], models, []),
    });

    const result = await agent.prompt(userMessage('switch model'));
    const failure = result.at(-1);

    expect(failure).toMatchObject({
      role: 'assistant',
      api: modelB.api,
      provider: modelB.provider,
      model: modelB.id,
      finishReason: 'error',
      errorMessage: 'second turn runtime failed',
    });
    expect(agent.state.model).toBe(modelA);
    expect(agent.state.errorInfo).toEqual({
      source: 'runtime',
      reason: 'error',
      message: 'second turn runtime failed',
    });
  });

  it('keeps the previous active model when prepareNextTurn throws before switching models', async () => {
    const call: ModelToolCall = {
      callId: 'call_1',
      name: 'query_logs',
      arguments: {},
    };
    const firstAssistant = assistantMessage(modelA, 'tool_calls', [call]);
    const agent = new Agent({
      model: modelA,
      tools: [textTool('query_logs', 'logs found')],
      prepareNextTurn: () => {
        throw new Error('prepare failed');
      },
      streamFn: sequentialStreamFn([assistantStream(firstAssistant)], [], []),
    });

    const result = await agent.prompt(userMessage('prepare failure'));
    const failure = result.at(-1);

    expect(failure).toMatchObject({
      role: 'assistant',
      api: modelA.api,
      provider: modelA.provider,
      model: modelA.id,
      finishReason: 'error',
      errorMessage: 'prepare failed',
    });
    expect(agent.state.model).toBe(modelA);
  });
});
