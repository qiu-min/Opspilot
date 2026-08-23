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
  type ToolResultMessage,
} from '@opspilot/model-gateway';

import { defaultConvertToLlm, runAgentLoop } from '../src/index.js';
import type {
  AgentContext,
  AgentEvent,
  AgentMessage,
  AgentTool,
  ShouldStopAfterTurnContext,
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
    const partial: AssistantMessage = { ...message, content: [], finishReason: 'pending' };
    controller.emit({ type: 'start', model, partial });
    if (delta !== undefined)
      controller.emit({
        type: 'text.delta',
        contentIndex: 0,
        delta,
        partial: { ...partial, content: [{ type: 'text', text: delta }] },
      });
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

/** 创建可由测试控制完成时机的 Promise。
 * @returns 包含 Promise 和完成函数的延迟对象。
 */
function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

describe('runAgentLoop tool loop', () => {
  it('ends after one model call when there are no tool calls', async () => {
    const prompt = createPrompt();
    const assistant = createAssistantMessage('stop');
    const contexts: Context[] = [];
    const streamFn = createSequentialStreamFn([createAssistantStream(assistant, 'done')], contexts);
    const events: AgentEvent[] = [];
    const context = createContext();
    const shouldStopAfterTurn = vi.fn(() => false);

    const result = await runAgentLoop(
      [prompt],
      context,
      { ...config, shouldStopAfterTurn },
      streamFn,
      (event) => {
        events.push(event);
      },
    );

    expect(contexts).toHaveLength(1);
    expect(shouldStopAfterTurn).toHaveBeenCalledTimes(1);
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
    const convertedInputs: AgentMessage[][] = [];
    const convertToLlm = vi.fn((messages: readonly AgentMessage[]) => {
      convertedInputs.push([...messages]);
      return defaultConvertToLlm(messages);
    });
    const events: AgentEvent[] = [];
    const context = createContext([tool]);

    const result = await runAgentLoop(
      [prompt],
      context,
      { ...config, convertToLlm },
      streamFn,
      (event) => {
        events.push(event);
      },
    );

    const toolResult = {
      role: 'tool' as const,
      callId: 'call_1',
      name: 'query_logs',
      content: [{ type: 'text' as const, text: 'logs found' }],
      isError: false,
    };
    expect(contexts).toHaveLength(2);
    expect(convertToLlm).toHaveBeenCalledTimes(2);
    expect(convertedInputs[0]).toEqual([...historicalMessages, prompt]);
    expect(convertedInputs[1]).toEqual([...historicalMessages, prompt, assistant1, toolResult]);
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
      'message_start',
      'message_end',
      'turn_end',
      'turn_start',
      'message_start',
      'message_end',
      'turn_end',
      'agent_end',
    ]);
    expect(events[6]).toEqual({ type: 'tool_execution_start', toolCall: call });
    expect(events[7]).toEqual({ type: 'tool_execution_end', toolCall: call, result: toolResult });
    expect(events[8]).toEqual({ type: 'message_start', message: toolResult });
    expect(events[9]).toEqual({ type: 'message_end', message: toolResult });
    expect(events[10]).toEqual({ type: 'turn_end', message: assistant1, toolResults: [toolResult] });
    expect(events[11]).toEqual({ type: 'turn_start' });
  });

  it('stops after a complete tool turn when policy requests it', async () => {
    const prompt = createPrompt();
    const call = {
      callId: 'call_policy',
      name: 'query_logs',
      arguments: { service: 'api' },
    };
    const execute = createExecuteSpy();
    const tool = createTextTool('query_logs', 'logs found', execute);
    const assistant = createAssistantMessage('tool_calls', [call]);
    const contexts: Context[] = [];
    const context = createContext([tool]);
    const events: AgentEvent[] = [];
    const streamFn = createSequentialStreamFn([createAssistantStream(assistant)], contexts);
    const shouldStopAfterTurn = vi.fn((_context: ShouldStopAfterTurnContext) => true);

    const result = await runAgentLoop(
      [prompt],
      context,
      { ...config, shouldStopAfterTurn },
      streamFn,
      (event) => {
        events.push(event);
      },
    );

    const toolResult = result[2];
    const hookContext = shouldStopAfterTurn.mock.calls[0]?.[0];
    expect(contexts).toHaveLength(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(hookContext?.message).toBe(assistant);
    expect(hookContext?.toolResults[0]).toBe(toolResult);
    expect(hookContext?.context.messages).toEqual([
      ...historicalMessages,
      prompt,
      assistant,
      toolResult,
    ]);
    expect(hookContext?.newMessages).toBe(result);
    expect(hookContext?.newMessages).toEqual([prompt, assistant, toolResult]);
    expect(events.map((event) => event.type).slice(-6)).toEqual([
      'tool_execution_start',
      'tool_execution_end',
      'message_start',
      'message_end',
      'turn_end',
      'agent_end',
    ]);
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
    expect(events.slice(6, 14).map((event) => event.type)).toEqual([
      'tool_execution_start',
      'tool_execution_end',
      'message_start',
      'message_end',
      'tool_execution_start',
      'tool_execution_end',
      'message_start',
      'message_end',
    ]);
    expect(events[6]).toEqual({ type: 'tool_execution_start', toolCall: call1 });
    expect(events[8]).toEqual({ type: 'message_start', message: expect.any(Object) });
    expect(events[10]).toEqual({ type: 'tool_execution_start', toolCall: call2 });
    expect(events[12]).toEqual({ type: 'message_start', message: expect.any(Object) });
  });

  it('publishes sequential ToolResult before starting a slow next tool', async () => {
    const prompt = createPrompt();
    const callA = { callId: 'call_A', name: 'tool_A', arguments: { service: 'api' } };
    const callB = { callId: 'call_B', name: 'tool_B', arguments: { service: 'api' } };
    const toolBStarted = createDeferred<void>();
    const toolBCompletion = createDeferred<void>();
    const toolA = createTextTool('tool_A', 'A', async () => ({ content: [] }));
    const toolB = createTextTool('tool_B', 'B', async () => {
      toolBStarted.resolve();
      await toolBCompletion.promise;
      return { content: [] };
    });
    const assistant1 = createAssistantMessage('tool_calls', [callA, callB]);
    const assistant2 = createAssistantMessage('stop');
    const events: AgentEvent[] = [];

    const run = runAgentLoop(
      [prompt],
      createContext([toolA, toolB]),
      config,
      createSequentialStreamFn([createAssistantStream(assistant1), createAssistantStream(assistant2)], []),
      (event) => {
        events.push(event);
      },
    );

    await toolBStarted.promise;
    const toolAResultEndIndex = events.findIndex(
      (event) =>
        event.type === 'message_end' &&
        event.message.role === 'tool' &&
        'callId' in event.message &&
        event.message.callId === callA.callId,
    );
    const toolBStartIndex = events.findIndex(
      (event) => event.type === 'tool_execution_start' && event.toolCall.callId === callB.callId,
    );

    expect(toolAResultEndIndex).toBeGreaterThanOrEqual(0);
    expect(toolBStartIndex).toBeGreaterThan(toolAResultEndIndex);

    toolBCompletion.resolve();
    await run;
  });

  it('keeps Agent Loop tool result messages in source order during parallel execution', async () => {
    const prompt = createPrompt();
    const callA = { callId: 'call_A', name: 'tool_A', arguments: { service: 'api' } };
    const callB = { callId: 'call_B', name: 'tool_B', arguments: { service: 'api' } };
    const completionA = createDeferred<void>();
    const completionB = createDeferred<void>();
    const started = createDeferred<void>();
    let startedCount = 0;
    const toolA = createTextTool('tool_A', 'A', async () => {
      startedCount += 1;
      if (startedCount === 2) started.resolve();
      await completionA.promise;
      return { content: [] };
    });
    const toolB = createTextTool('tool_B', 'B', async () => {
      startedCount += 1;
      if (startedCount === 2) started.resolve();
      await completionB.promise;
      return { content: [] };
    });
    const assistant1 = createAssistantMessage('tool_calls', [callA, callB]);
    const assistant2 = createAssistantMessage('stop');
    const events: AgentEvent[] = [];

    const run = runAgentLoop(
      [prompt],
      createContext([toolA, toolB]),
      { ...config, toolExecution: 'parallel' },
      createSequentialStreamFn([createAssistantStream(assistant1), createAssistantStream(assistant2)], []),
      (event) => {
        events.push(event);
      },
    );

    await started.promise;
    completionB.resolve();
    await Promise.resolve();
    completionA.resolve();
    const result = await run;

    expect(
      events
        .filter((event): event is Extract<AgentEvent, { type: 'tool_execution_end' }> =>
          event.type === 'tool_execution_end',
        )
        .map((event) => event.toolCall.callId),
    ).toEqual(['call_B', 'call_A']);
    expect(
      result
        .filter((message): message is ToolResultMessage => message.role === 'tool')
        .map((message) => message.callId),
    ).toEqual(['call_A', 'call_B']);
    expect(
      events
        .filter(
          (event): event is Extract<AgentEvent, { type: 'message_start' }> =>
            event.type === 'message_start' && event.message.role === 'tool',
        )
        .map((event) => ('callId' in event.message ? event.message.callId : '')),
    ).toEqual(['call_A', 'call_B']);
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
    const shouldStopAfterTurn = vi.fn((_context: ShouldStopAfterTurnContext) => false);

    await runAgentLoop(
      [createPrompt()],
      createContext([tool]),
      { ...config, shouldStopAfterTurn },
      createSequentialStreamFn([createAssistantStream(assistant)], []),
      (event) => {
        events.push(event);
      },
    );

    expect(execute).not.toHaveBeenCalled();
    expect(shouldStopAfterTurn).toHaveBeenCalledTimes(1);
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
    const shouldStopAfterTurn = vi.fn((_context: ShouldStopAfterTurnContext) => false);

    await runAgentLoop(
      [createPrompt()],
      createContext([tool]),
      { ...config, shouldStopAfterTurn },
      createSequentialStreamFn([createAssistantStream(assistant)], []),
      (event) => {
        events.push(event);
      },
    );

    expect(execute).not.toHaveBeenCalled();
    expect(shouldStopAfterTurn).toHaveBeenCalledTimes(1);
    expect(events.map((event) => event.type).slice(-2)).toEqual(['turn_end', 'agent_end']);
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

  it('completes the agent lifecycle for a terminal model error', async () => {
    const failure: AssistantMessage = {
      ...createAssistantMessage('error'),
      errorMessage: 'Timed out.',
    };
    const stream = createModelEventStream(async (controller) => {
      controller.emit({ type: 'start', model, partial: createAssistantMessage('pending') });
      controller.error(failure);
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
    ).resolves.toEqual([createPrompt(), failure]);
    expect(events.map((event) => event.type)).toEqual([
      'agent_start',
      'turn_start',
      'message_start',
      'message_end',
      'message_start',
      'message_end',
      'turn_end',
      'agent_end',
    ]);
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'tool_execution_start' }));
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'tool_execution_end' }));
  });

  it('completes an error without start and skips later hooks and queues', async () => {
    const failure: AssistantMessage = {
      ...createAssistantMessage('aborted'),
      errorMessage: 'Request aborted.',
    };
    const stream = createModelEventStream(async (controller) => controller.error(failure));
    const getSteeringMessages = vi.fn(() => []);
    const getFollowUpMessages = vi.fn(() => []);
    const prepareNextTurn = vi.fn();
    const shouldStopAfterTurn = vi.fn();
    const events: AgentEvent[] = [];

    await expect(
      runAgentLoop(
        [createPrompt()],
        createContext(),
        {
          ...config,
          getSteeringMessages,
          getFollowUpMessages,
          prepareNextTurn,
          shouldStopAfterTurn,
        },
        () => stream,
        (event) => {
          events.push(event);
        },
      ),
    ).resolves.toEqual([createPrompt(), failure]);

    expect(events.map((event) => event.type)).toEqual([
      'agent_start',
      'turn_start',
      'message_start',
      'message_end',
      'message_start',
      'message_end',
      'turn_end',
      'agent_end',
    ]);
    expect(events[4]).toEqual({ type: 'message_start', message: { ...failure } });
    expect(events[5]).toEqual({ type: 'message_end', message: failure });
    expect(getSteeringMessages).toHaveBeenCalledTimes(1);
    expect(getFollowUpMessages).not.toHaveBeenCalled();
    expect(prepareNextTurn).not.toHaveBeenCalled();
    expect(shouldStopAfterTurn).not.toHaveBeenCalled();
  });

  it('keeps unexpected stream runtime errors rejected', async () => {
    const failure = new Error('unexpected stream failure');
    const stream = createModelEventStream(async () => {
      throw failure;
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
    ).rejects.toBe(failure);
    expect(events.map((event) => event.type)).toEqual([
      'agent_start',
      'turn_start',
      'message_start',
      'message_end',
    ]);
  });
});
