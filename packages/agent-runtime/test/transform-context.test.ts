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

import { defaultConvertToLlm, runAgentLoop } from '../src/index.js';
import type {
  AgentContext,
  AgentLoopConfig,
  AgentMessage,
  AgentTool,
  StreamFn,
} from '../src/index.js';

declare module '../src/types.js' {
  interface CustomAgentMessages {
    transformTest: {
      readonly role: 'transform-test';
      readonly value: string;
    };
  }
}

const model: Model = {
  provider: 'test-provider',
  id: 'test-model',
  name: 'Test Model',
  api: 'test-api',
  baseUrl: 'https://model.example.test/v1',
  reasoning: false,
};

const messageA: AgentMessage = {
  role: 'user',
  content: [{ type: 'text', text: 'message A' }],
};

const messageB: AgentMessage = {
  role: 'user',
  content: [{ type: 'text', text: 'message B' }],
};

/** 创建标准的模型 assistant 消息。
 * @param finishReason 模型本次响应的结束原因。
 * @param toolCalls 模型本次请求执行的工具调用列表。
 */
function createAssistantMessage(
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

/** 创建只完成一次模型响应的事件流。
 * @param message 模型最终返回的 assistant 消息。
 */
function createAssistantStream(message: AssistantMessage): ModelEventStream {
  return createModelEventStream(async (controller) => {
    controller.emit({ type: 'start', model });
    controller.complete(message);
  });
}

/** 创建按顺序返回模型事件流的函数。
 * @param streams 各 Turn 要返回的模型事件流。
 * @param contexts 记录每次传给模型的上下文。
 */
function createSequentialStreamFn(
  streams: readonly ModelEventStream[],
  contexts: Context[],
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

/** 创建使用固定结果的测试工具。
 * @param name 工具名称。
 * @param text 工具返回的文本。
 */
function createTextTool(name: string, text: string): AgentTool {
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

/** 创建一份不共享消息数组的 Agent 上下文。
 * @param messages 初始 Agent 消息历史。
 * @param tools 当前上下文允许使用的工具。
 */
function createContext(
  messages: readonly AgentMessage[] = [messageA, messageB],
  tools?: readonly AgentTool[],
): AgentContext {
  return {
    messages: [...messages],
    ...(tools === undefined ? {} : { tools }),
  };
}

describe('transformContext', () => {
  it('keeps the original model context when the hook is not configured', async () => {
    const contexts: Context[] = [];
    const assistant = createAssistantMessage();

    await runAgentLoop(
      [],
      createContext(),
      { model },
      createSequentialStreamFn([createAssistantStream(assistant)], contexts),
      () => undefined,
    );

    expect(contexts[0]?.messages).toEqual([messageA, messageB]);
  });

  it('runs before convertToLlm and passes the transformed messages to the model', async () => {
    const contexts: Context[] = [];
    const transformed = [messageB];
    const assistant = createAssistantMessage();
    const transformContext = vi.fn(() => transformed);
    const convertedInputs: AgentMessage[][] = [];
    const convertToLlm = vi.fn((messages: readonly AgentMessage[]) => {
      convertedInputs.push([...messages]);
      return defaultConvertToLlm(messages);
    });
    const config: AgentLoopConfig = { model, transformContext, convertToLlm };

    await runAgentLoop(
      [],
      createContext(),
      config,
      createSequentialStreamFn([createAssistantStream(assistant)], contexts),
      () => undefined,
    );

    expect(transformContext).toHaveBeenCalledTimes(1);
    expect(convertToLlm).toHaveBeenCalledTimes(1);
    expect(convertedInputs).toEqual([transformed]);
    expect(contexts[0]?.messages).toEqual([messageB]);
  });

  it('runs once for every model turn and observes the growing Agent history', async () => {
    const call: ModelToolCall = {
      callId: 'call_1',
      name: 'query_logs',
      arguments: {},
    };
    const tool = createTextTool('query_logs', 'logs found');
    const assistant1 = createAssistantMessage('tool_calls', [call]);
    const assistant2 = createAssistantMessage();
    const contexts: Context[] = [];
    const transformedInputs: AgentMessage[][] = [];
    const transformContext = vi.fn((messages: readonly AgentMessage[]) => {
      transformedInputs.push([...messages]);
      return messages;
    });

    await runAgentLoop(
      [],
      createContext([messageA, messageB], [tool]),
      { model, transformContext },
      createSequentialStreamFn(
        [createAssistantStream(assistant1), createAssistantStream(assistant2)],
        contexts,
      ),
      () => undefined,
    );

    const toolResult = {
      role: 'tool' as const,
      callId: call.callId,
      name: call.name,
      content: [{ type: 'text' as const, text: 'logs found' }],
      isError: false,
    };
    expect(transformContext).toHaveBeenCalledTimes(2);
    expect(transformedInputs[0]).toEqual([messageA, messageB]);
    expect(transformedInputs[1]).toEqual([messageA, messageB, assistant1, toolResult]);
    expect(contexts[0]?.messages).toEqual([messageA, messageB]);
    expect(contexts[1]?.messages).toEqual([messageA, messageB, assistant1, toolResult]);
  });

  it('uses a temporary view without mutating the caller context or run messages', async () => {
    const prompt: AgentMessage = {
      role: 'user',
      content: [{ type: 'text', text: 'current prompt' }],
    };
    const call: ModelToolCall = {
      callId: 'call_1',
      name: 'query_logs',
      arguments: {},
    };
    const tool = createTextTool('query_logs', 'logs found');
    const assistant = createAssistantMessage('tool_calls', [call]);
    const context = createContext([messageA, messageB], [tool]);
    const originalMessages = [...context.messages];
    const contexts: Context[] = [];
    const transformContext = vi.fn((messages: readonly AgentMessage[]) => messages.slice(-1));

    const result = await runAgentLoop(
      [prompt],
      context,
      {
        model,
        transformContext,
        shouldStopAfterTurn: () => true,
      },
      createSequentialStreamFn([createAssistantStream(assistant)], contexts),
      () => undefined,
    );

    expect(context.messages).toEqual(originalMessages);
    expect(contexts[0]?.messages).toEqual([prompt]);
    expect(result).toHaveLength(3);
    expect(result[0]).toBe(prompt);
    expect(result[1]).toBe(assistant);
    expect(result[2]).toMatchObject({ role: 'tool', callId: call.callId });
  });

  it('keeps custom AgentMessages in the transform world until convertToLlm', async () => {
    const customMessage: AgentMessage = {
      role: 'transform-test',
      value: 'database is healthy',
    };
    const assistant = createAssistantMessage();
    const convertedInputs: AgentMessage[][] = [];
    const contexts: Context[] = [];
    const transformContext = vi.fn(() => [customMessage]);
    const convertToLlm = vi.fn((messages: readonly AgentMessage[]): readonly Message[] => {
      convertedInputs.push([...messages]);
      return messages.flatMap((message): Message[] => {
        if (message.role === 'transform-test') {
          return [
            {
              role: 'user',
              content: [{ type: 'text', text: 'Evidence: database is healthy' }],
            },
          ];
        }
        return defaultConvertToLlm([message]);
      });
    });

    await runAgentLoop(
      [],
      createContext(),
      { model, transformContext, convertToLlm },
      createSequentialStreamFn([createAssistantStream(assistant)], contexts),
      () => undefined,
    );

    expect(convertedInputs).toEqual([[customMessage]]);
    expect(contexts[0]?.messages).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'Evidence: database is healthy' }],
      },
    ]);
  });

  it('passes the same AbortSignal to transformContext', async () => {
    const controller = new AbortController();
    const assistant = createAssistantMessage();
    const transformContext = vi.fn(
      (messages: readonly AgentMessage[], signal?: AbortSignal) => {
        expect(signal).toBe(controller.signal);
        return messages;
      },
    );

    await runAgentLoop(
      [],
      createContext(),
      { model, transformContext },
      createSequentialStreamFn([createAssistantStream(assistant)], []),
      () => undefined,
      controller.signal,
    );

    expect(transformContext).toHaveBeenCalledTimes(1);
  });
});
