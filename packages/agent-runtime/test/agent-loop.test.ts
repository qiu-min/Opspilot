import { describe, expect, it, vi } from 'vitest';
import {
  createModelEventStream,
  ModelGatewayError,
  type AssistantMessage,
  type Context,
  type FinishReason,
  type JsonObject,
  type Message,
  type Model,
  type ModelEventStream,
  type ModelToolCall,
} from '@opspilot/model-gateway';

import { runAgentLoop } from '../src/index.js';
import type { AgentContext, AgentEvent, AgentMessage, AgentTool, StreamFn } from '../src/index.js';

const model: Model = {
  provider: 'test-provider',
  id: 'test-model',
  name: 'Test Model',
  api: 'test-api',
  baseUrl: 'https://model.example.test/v1',
  reasoning: false,
};

const historicalMessages: AgentMessage[] = [
  {
    role: 'user',
    content: [{ type: 'text', text: 'Investigate the first alert.' }],
  },
  {
    role: 'assistant',
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [{ type: 'text', text: 'The first alert was investigated.' }],
    finishReason: 'stop',
  },
];

const config = { model };

/** 创建一份不共享消息数组的测试上下文。 */
function createContext(tools?: readonly AgentTool[]): AgentContext {
  return {
    messages: [...historicalMessages],
    ...(tools === undefined ? {} : { tools }),
  };
}

/** 创建本次运行的用户 prompt。 */
function createPrompt(): AgentMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text: 'Investigate the second alert.' }],
  };
}

/** 创建模型返回的标准 assistant 消息。
 * @param finishReason 模型本次响应的结束原因。
 * @param toolCalls 模型请求执行的工具调用列表。
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

/** 创建只产生一次模型响应的事件流。
 * @param message 模型最终返回的 assistant 消息。
 * @param delta 可选的文本增量，用于覆盖消息事件映射。
 */
function createAssistantStream(message: AssistantMessage, delta?: string): ModelEventStream {
  return createModelEventStream(async (controller) => {
    controller.emit({ type: 'start', model });
    if (delta !== undefined) controller.emit({ type: 'text.delta', contentIndex: 0, delta });
    controller.complete(message);
  });
}

/** 按顺序返回多次模型响应，并记录每次收到的上下文。
 * @param streams 各轮模型响应流。
 * @param contexts 用于记录传给模型的上下文。
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

/** 创建返回固定文本结果的运行时工具。
 * @param name 工具名称。
 * @param text 工具返回的文本。
 * @param execute 工具执行函数。
 */
function createTextTool(name: string, text: string, execute: AgentTool['execute']): AgentTool {
  return {
    name,
    description: `Test tool ${name}`,
    parameters: {
      type: 'object',
      properties: { service: { type: 'string' } },
      required: ['service'],
      additionalProperties: false,
    },
    execute: async (callId: string, args: JsonObject, signal?: AbortSignal) => {
      await execute(callId, args, signal);
      return { content: [{ type: 'text', text }] };
    },
  };
}

/** 创建可追踪调用次数的工具执行函数。 */
function createExecuteSpy() {
  return vi.fn(async (_callId: string, _args: JsonObject, _signal?: AbortSignal) => ({
    content: [{ type: 'text' as const, text: 'executed' }],
  }));
}

describe('runAgentLoop tool loop', () => {
  it('ends after one model call when there are no tool calls', async () => {
    const prompt = createPrompt();
    const assistant = createAssistantMessage('stop');
    const contexts: Context[] = [];
    const streamFn = createSequentialStreamFn([createAssistantStream(assistant, 'done')], contexts);
    const events: AgentEvent[] = [];
    const context = createContext();

    const result = await runAgentLoop([prompt], context, config, streamFn, (event) => {
      events.push(event);
    });

    expect(contexts).toHaveLength(1);
    expect(result).toEqual([prompt, assistant]);
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
  });

  it('executes one tool and gives its result to the next turn', async () => {
    const prompt = createPrompt();
    const call = {
      callId: 'call_1',
      name: 'query_logs',
      arguments: { service: 'api' },
    };
    const execute = createExecuteSpy();
    const tool = createTextTool('query_logs', 'logs found', execute);
    const assistant1 = createAssistantMessage('tool_calls', [call]);
    const assistant2 = createAssistantMessage('stop');
    const contexts: Context[] = [];
    const streamFn = createSequentialStreamFn(
      [createAssistantStream(assistant1), createAssistantStream(assistant2)],
      contexts,
    );
    const events: AgentEvent[] = [];
    const context = createContext([tool]);

    const result = await runAgentLoop([prompt], context, config, streamFn, (event) => {
      events.push(event);
    });

    const toolResult = {
      role: 'tool' as const,
      callId: 'call_1',
      name: 'query_logs',
      content: [{ type: 'text' as const, text: 'logs found' }],
      isError: false,
    };
    expect(contexts).toHaveLength(2);
    expect(contexts[1]?.messages).toEqual([...historicalMessages, prompt, assistant1, toolResult]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result).toEqual([prompt, assistant1, toolResult, assistant2]);
    expect(events.map((event) => event.type)).toEqual([
      'agent_start',
      'turn_start',
      'message_start',
      'message_end',
      'message_start',
      'message_end',
      'tool_execution_start',
      'tool_execution_end',
      'turn_end',
      'turn_start',
      'message_start',
      'message_end',
      'turn_end',
      'agent_end',
    ]);
    expect(events[6]).toEqual({ type: 'tool_execution_start', toolCall: call });
    expect(events[7]).toEqual({ type: 'tool_execution_end', toolCall: call, result: toolResult });
    expect(events[8]).toEqual({ type: 'turn_end', message: assistant1, toolResults: [toolResult] });
    expect(events[9]).toEqual({ type: 'turn_start' });
  });

  it('executes multiple tool calls in order within one turn', async () => {
    const prompt = createPrompt();
    const call1 = {
      callId: 'call_1',
      name: 'query_logs',
      arguments: { service: 'api' },
    };
    const call2 = {
      callId: 'call_2',
      name: 'query_metrics',
      arguments: { service: 'api' },
    };
    const execute1 = createExecuteSpy();
    const execute2 = createExecuteSpy();
    const tool1 = createTextTool('query_logs', 'logs found', execute1);
    const tool2 = createTextTool('query_metrics', 'metrics found', execute2);
    const assistant1 = createAssistantMessage('tool_calls', [call1, call2]);
    const assistant2 = createAssistantMessage('stop');
    const events: AgentEvent[] = [];
    const context = createContext([tool1, tool2]);
    const streamFn = createSequentialStreamFn(
      [createAssistantStream(assistant1), createAssistantStream(assistant2)],
      [],
    );

    await runAgentLoop([prompt], context, config, streamFn, (event) => {
      events.push(event);
    });

    expect(execute1).toHaveBeenCalledTimes(1);
    expect(execute2).toHaveBeenCalledTimes(1);
    expect(events.slice(6, 12).map((event) => event.type)).toEqual([
      'tool_execution_start',
      'tool_execution_end',
      'tool_execution_start',
      'tool_execution_end',
      'turn_end',
      'turn_start',
    ]);
    expect(events[6]).toEqual({ type: 'tool_execution_start', toolCall: call1 });
    expect(events[8]).toEqual({ type: 'tool_execution_start', toolCall: call2 });
  });

  it('does not execute tools when finishReason is length', async () => {
    const call = {
      callId: 'call_length',
      name: 'query_logs',
      arguments: { service: 'api' },
    };
    const execute = createExecuteSpy();
    const tool = createTextTool('query_logs', 'should not run', execute);
    const assistant = createAssistantMessage('length', [call]);
    const events: AgentEvent[] = [];

    await runAgentLoop(
      [createPrompt()],
      createContext([tool]),
      config,
      createSequentialStreamFn([createAssistantStream(assistant)], []),
      (event) => {
        events.push(event);
      },
    );

    expect(execute).not.toHaveBeenCalled();
    expect(events.map((event) => event.type).slice(-2)).toEqual(['turn_end', 'agent_end']);
  });

  it('does not execute tools when finishReason is refusal', async () => {
    const call = {
      callId: 'call_refusal',
      name: 'query_logs',
      arguments: { service: 'api' },
    };
    const execute = createExecuteSpy();
    const tool = createTextTool('query_logs', 'should not run', execute);
    const assistant = createAssistantMessage('refusal', [call]);
    const events: AgentEvent[] = [];

    await runAgentLoop(
      [createPrompt()],
      createContext([tool]),
      config,
      createSequentialStreamFn([createAssistantStream(assistant)], []),
      (event) => {
        events.push(event);
      },
    );

    expect(execute).not.toHaveBeenCalled();
    expect(events.map((event) => event.type).slice(-2)).toEqual(['turn_end', 'agent_end']);
  });

  it('stops after maxTurns without making a third model call', async () => {
    const call = {
      callId: 'call_repeat',
      name: 'query_logs',
      arguments: { service: 'api' },
    };
    const execute = createExecuteSpy();
    const tool = createTextTool('query_logs', 'logs found', execute);
    const assistant1 = createAssistantMessage('tool_calls', [call]);
    const assistant2 = createAssistantMessage('tool_calls', [call]);
    const contexts: Context[] = [];
    const streamFn = createSequentialStreamFn(
      [createAssistantStream(assistant1), createAssistantStream(assistant2)],
      contexts,
    );
    const events: AgentEvent[] = [];

    const result = await runAgentLoop(
      [createPrompt()],
      createContext([tool]),
      { ...config, maxTurns: 2 },
      streamFn,
      (event) => {
        events.push(event);
      },
    );

    expect(contexts).toHaveLength(2);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(events.filter((event) => event.type === 'turn_end')).toHaveLength(2);
    expect(events.filter((event) => event.type === 'agent_end')).toHaveLength(1);
    expect(result).toHaveLength(5);
  });

  it('keeps the caller context unchanged while the loop context grows', async () => {
    const prompt = createPrompt();
    const context = createContext();
    const originalMessages = [...context.messages];
    const observedContexts: Context[] = [];
    const assistant = createAssistantMessage('stop');

    await runAgentLoop(
      [prompt],
      context,
      config,
      createSequentialStreamFn([createAssistantStream(assistant)], observedContexts),
      () => undefined,
    );

    expect(context.messages).toEqual(originalMessages);
    expect(observedContexts[0]?.messages).toEqual([...originalMessages, prompt]);
    expect(observedContexts[0]?.messages).not.toBe(context.messages);
  });

  it('accepts a standard model Message as an AgentMessage', () => {
    const message: Message = {
      role: 'user',
      content: [{ type: 'text', text: 'A standard model message.' }],
    };
    const agentMessage: AgentMessage = message;

    expect(agentMessage).toBe(message);
  });

  it('propagates a model stream error without inventing agent_end', async () => {
    const error = new ModelGatewayError('TIMEOUT', 'Timed out.');
    const stream = createModelEventStream(async (controller) => {
      controller.emit({ type: 'start', model });
      controller.fail(error);
    });
    const events: AgentEvent[] = [];

    await expect(
      runAgentLoop(
        [createPrompt()],
        createContext(),
        config,
        () => stream,
        (event) => {
          events.push(event);
        },
      ),
    ).rejects.toBe(error);
    expect(events.some((event) => event.type === 'agent_end')).toBe(false);
  });
});
