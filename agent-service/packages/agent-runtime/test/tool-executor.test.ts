import { describe, expect, it, vi } from 'vitest';
import type { AssistantMessage, ModelToolCall } from '@opspilot/model-gateway';

import {
  AgentToolExecutionError,
  type AgentToolResult,
} from '../src/index.js';
import {
  executeToolCall,
  executeToolCalls,
  type ExecuteToolCallOptions,
} from '../src/tool-executor.js';
import type { AgentTool } from '../src/types.js';
import type { ToolResultMessage } from '@opspilot/model-gateway';

const execute = vi.fn();

const tool: AgentTool = {
  name: 'queryLogs',
  description: 'Query logs',
  parameters: {
    type: 'object',
    properties: {
      service: {
        type: 'string',
      },
    },
    required: ['service'],
    additionalProperties: false,
  },

  execute,
};

execute.mockResolvedValue({
  content: [
    {
      type: 'text',
      text: 'logs found',
    },
  ],
});

const toolCall: ModelToolCall = {
  callId: 'call_1',
  name: 'queryLogs',
  arguments: {
    service: 'api',
  },
};

const assistantMessage: AssistantMessage = {
  role: 'assistant',
  api: 'test-api',
  provider: 'test-provider',
  model: 'test-model',
  content: [],
  toolCalls: [toolCall],
  finishReason: 'tool_calls',
};

/** 创建带有 beforeToolCall 的测试执行选项。
 * @param beforeToolCall 本次测试要运行的工具拦截 hook。
 * @returns 包含 assistant、上下文和 hook 的执行选项。
 */
function createExecutionOptions(
  beforeToolCall?: ExecuteToolCallOptions['beforeToolCall'],
  afterToolCall?: ExecuteToolCallOptions['afterToolCall'],
  selectedTool: AgentTool = tool,
): ExecuteToolCallOptions {
  return {
    assistantMessage,
    context: {
      messages: [],
      tools: [selectedTool],
    },
    ...(beforeToolCall === undefined ? {} : { beforeToolCall }),
    ...(afterToolCall === undefined ? {} : { afterToolCall }),
  };
}

/** 创建一个可由测试控制完成时机的 Promise。
 * @returns 包含 Promise、resolve 和 reject 的延迟对象。
 */
function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

/** 创建批量执行测试使用的 ToolCall。
 * @param name Tool 名称和结果标识。
 * @returns 使用 service 参数的模型工具调用。
 */
function createBatchToolCall(name: string): ModelToolCall {
  return {
    callId: `call_${name}`,
    name,
    arguments: { service: 'api' },
  };
}

/** 创建批量执行测试使用的运行时工具。
 * @param name Tool 名称。
 * @param execute Tool 的执行实现。
 * @returns 带有统一参数 schema 的 AgentTool。
 */
function createBatchTool(name: string, execute: AgentTool['execute']): AgentTool {
  return {
    name,
    description: `Test tool ${name}`,
    parameters: {
      type: 'object',
      properties: { service: { type: 'string' } },
      required: ['service'],
      additionalProperties: false,
    },
    execute,
  };
}

/** 创建批量执行所需的通用上下文。
 * @param tools 本批次允许使用的工具。
 * @returns 包含 assistant 和 AgentContext 的批量选项基础数据。
 */
function createBatchContext(tools: readonly AgentTool[]): {
  readonly assistantMessage: AssistantMessage;
  readonly context: ExecuteToolCallOptions['context'];
} {
  return {
    assistantMessage,
    context: { messages: [], tools },
  };
}

it('executes tool with valid arguments', async () => {
  execute.mockResolvedValue({
    content: [
      {
        type: 'text',
        text: 'logs found',
      },
    ],
  });

  const toolCall: ModelToolCall = {
    callId: 'call_1',
    name: 'queryLogs',
    arguments: {
      service: 'api',
    },
  };

  const result = await executeToolCall(
    toolCall,
    [tool],
  );

  expect(result).toEqual({
    role: 'tool',
    callId: 'call_1',
    name: 'queryLogs',
    content: [
      {
        type: 'text',
        text: 'logs found',
      },
    ],
    isError: false,
  });

  expect(execute).toHaveBeenCalledWith(
    'call_1',
    {
        service: 'api',
    },
    undefined,
  );
});



it('returns error when tool is not found', async () => {
  const toolCall: ModelToolCall = {
    callId: 'call_2',
    name: 'unknownTool',
    arguments: {},
  };

  const result = await executeToolCall(
    toolCall,
    [tool],
  );

  expect(result.isError).toBe(true);
  expect(result.callId).toBe('call_2');
  expect(result.name).toBe('unknownTool');
});

it('returns error when tool arguments are invalid', async () => {
  execute.mockClear();

  const toolCall: ModelToolCall = {
    callId: 'call_3',
    name: 'queryLogs',
    arguments: {
      service: 123,
    },
  };

  const result = await executeToolCall(
    toolCall,
    [tool],
  );

  expect(result.isError).toBe(true);

  expect(execute).not.toHaveBeenCalled();
});

it('passes structured AgentToolResult details through to ToolResultMessage', async () => {
  const details = { source: 'logs', matchedEntries: 3 };
  const structuredTool: AgentTool<typeof details> = {
    name: 'structuredTool',
    description: 'Returns structured details',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => ({
      content: [{ type: 'text', text: 'done' }],
      details,
    }),
  };

  const result = await executeToolCall(
    { ...toolCall, name: structuredTool.name, arguments: {} },
    [structuredTool],
  );

  expect(result.details).toBe(details);
  expect(result).toMatchObject({
    content: [{ type: 'text', text: 'done' }],
    isError: false,
  });
});

it('allows afterToolCall to override structured details', async () => {
  const originalDetails = { source: 'tool', matchedEntries: 3 };
  const finalDetails = { source: 'policy', matchedEntries: 0 };
  const structuredTool: AgentTool<typeof originalDetails> = {
    name: 'structuredTool',
    description: 'Returns structured details',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => ({
      content: [{ type: 'text', text: 'done' }],
      details: originalDetails,
    }),
  };

  let receivedDetails: unknown;
  const result = await executeToolCall(
    { ...toolCall, name: structuredTool.name, arguments: {} },
    [structuredTool],
    createExecutionOptions(
      undefined,
      ({ result: executed }) => {
        receivedDetails = executed.details;
        return { details: finalDetails };
      },
      structuredTool,
    ),
  );

  expect(receivedDetails).toBe(originalDetails);
  expect(result.details).toBe(finalDetails);
});

it('allows execution when beforeToolCall returns undefined', async () => {
  execute.mockClear();
  execute.mockResolvedValue({
    content: [{ type: 'text', text: 'logs found' }],
  });
  let receivedArgs: Record<string, unknown> | undefined;

  const result = await executeToolCall(
    toolCall,
    [tool],
    createExecutionOptions(({ args }) => {
      receivedArgs = args;
      return undefined;
    }),
  );

  expect(result.isError).toBe(false);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(receivedArgs).toEqual({ service: 'api' });
});

it('blocks execution and returns the policy reason', async () => {
  execute.mockClear();

  const result = await executeToolCall(
    toolCall,
    [tool],
    createExecutionOptions(() => ({
      block: true,
      reason: 'Production restart requires approval.',
    })),
  );

  expect(result).toEqual({
    role: 'tool',
    callId: toolCall.callId,
    name: toolCall.name,
    content: [{ type: 'text', text: 'Production restart requires approval.' }],
    details: { kind: 'recoverable', code: 'TOOL_BLOCKED' },
    isError: true,
  });
  expect(execute).not.toHaveBeenCalled();
});

it('uses the default reason when beforeToolCall blocks without one', async () => {
  execute.mockClear();

  const result = await executeToolCall(
    toolCall,
    [tool],
    createExecutionOptions(() => ({ block: true })),
  );

  expect(result.content).toEqual([
    { type: 'text', text: 'Tool execution was blocked.' },
  ]);
  expect(result.isError).toBe(true);
  expect(result.details).toEqual({ kind: 'recoverable', code: 'TOOL_BLOCKED' });
  expect(execute).not.toHaveBeenCalled();
});

it('converts beforeToolCall internal exceptions into safe internal Tool errors', async () => {
  execute.mockClear();

  const result = await executeToolCall(
    toolCall,
    [tool],
    createExecutionOptions(() => {
      throw new TypeError('policy failed');
    }),
  );

  expect(result.isError).toBe(true);
  expect(result.content).toEqual([
    { type: 'text', text: 'Tool execution failed due to an internal error.' },
  ]);
  expect(result.details).toEqual({ kind: 'internal', code: 'TOOL_INTERNAL_ERROR' });
  expect(execute).not.toHaveBeenCalled();
});

it('keeps the original result when afterToolCall returns undefined', async () => {
  execute.mockClear();
  execute.mockResolvedValue({
    content: [{ type: 'text', text: 'raw logs' }],
  });

  const result = await executeToolCall(
    toolCall,
    [tool],
    createExecutionOptions(undefined, () => undefined),
  );

  expect(result).toMatchObject({
    content: [{ type: 'text', text: 'raw logs' }],
    isError: false,
  });
});

it('allows afterToolCall to override content and isError independently', async () => {
  execute.mockClear();
  execute.mockResolvedValue({
    content: [{ type: 'text', text: 'raw logs' }],
  });

  const contentResult = await executeToolCall(
    toolCall,
    [tool],
    createExecutionOptions(undefined, () => ({
      content: [{ type: 'text', text: 'sanitized logs' }],
    })),
  );
  const errorResult = await executeToolCall(
    toolCall,
    [tool],
    createExecutionOptions(undefined, () => ({ isError: true })),
  );

  expect(contentResult.content).toEqual([{ type: 'text', text: 'sanitized logs' }]);
  expect(contentResult.isError).toBe(false);
  expect(errorResult.content).toEqual([{ type: 'text', text: 'raw logs' }]);
  expect(errorResult.isError).toBe(true);
});

it('does not expose internal execution errors to ToolResultMessage or afterToolCall', async () => {
  execute.mockClear();
  execute.mockRejectedValue(new Error('ECONNREFUSED'));
  let afterCalled = false;

  const result = await executeToolCall(
    toolCall,
    [tool],
    createExecutionOptions(undefined, () => {
      afterCalled = true;
      return undefined;
    }),
  );

  expect(afterCalled).toBe(false);
  expect(result.content).toEqual([
    { type: 'text', text: 'Tool execution failed due to an internal error.' },
  ]);
  expect(result.details).toEqual({ kind: 'internal', code: 'TOOL_INTERNAL_ERROR' });
  expect(result.isError).toBe(true);
});

it('converts afterToolCall internal exceptions into safe internal Tool errors', async () => {
  execute.mockClear();
  execute.mockResolvedValue({
    content: [{ type: 'text', text: 'raw logs' }],
  });

  const result = await executeToolCall(
    toolCall,
    [tool],
    createExecutionOptions(undefined, () => {
      throw new Error('result policy failed');
    }),
  );

  expect(result.isError).toBe(true);
  expect(result.content).toEqual([
    { type: 'text', text: 'Tool execution failed due to an internal error.' },
  ]);
  expect(result.details).toEqual({ kind: 'internal', code: 'TOOL_INTERNAL_ERROR' });
});

it('keeps AgentToolExecutionError recoverable with its code and data', async () => {
  execute.mockRejectedValue(
    new AgentToolExecutionError('Invalid range.', 'INVALID_RANGE', { start: 3, end: 1 }),
  );

  const result = await executeToolCall(toolCall, [tool]);

  expect(result).toMatchObject({
    isError: true,
    content: [{ type: 'text', text: 'Invalid range.' }],
    details: {
      kind: 'recoverable',
      code: 'INVALID_RANGE',
      data: { start: 3, end: 1 },
    },
  });
});

it('does not call afterToolCall for a beforeToolCall block', async () => {
  execute.mockClear();
  let afterCalled = false;

  const result = await executeToolCall(
    toolCall,
    [tool],
    createExecutionOptions(
      () => ({ block: true, reason: 'blocked' }),
      () => {
        afterCalled = true;
        return undefined;
      },
    ),
  );

  expect(result.content).toEqual([{ type: 'text', text: 'blocked' }]);
  expect(result.isError).toBe(true);
  expect(afterCalled).toBe(false);
  expect(execute).not.toHaveBeenCalled();
});

it('executes three tools sequentially without overlap', async () => {
  const eventOrder: string[] = [];
  let active = 0;
  let maxActive = 0;
  const tools = ['A', 'B', 'C'].map((name) =>
    createBatchTool(name, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      return { content: [{ type: 'text', text: name }] };
    }),
  );
  const toolCalls = tools.map((tool) => createBatchToolCall(tool.name));
  const { assistantMessage, context } = createBatchContext(tools);

  await executeToolCalls({
    toolCalls,
    tools,
    assistantMessage,
    context,
    toolExecution: 'sequential',
    emit: (event) => {
      if (event.type === 'tool_execution_start') eventOrder.push(`${event.toolCall.name} start`);
      if (event.type === 'tool_execution_end') eventOrder.push(`${event.toolCall.name} end`);
    },
  });

  expect(eventOrder).toEqual([
    'A start',
    'A end',
    'B start',
    'B end',
    'C start',
    'C end',
  ]);
  expect(maxActive).toBe(1);
});

it('keeps the default tool execution mode sequential', async () => {
  const order: string[] = [];
  const tools = ['A', 'B', 'C'].map((name) =>
    createBatchTool(name, async () => {
      order.push(`${name} execute`);
      return { content: [{ type: 'text', text: name }] };
    }),
  );
  const { assistantMessage, context } = createBatchContext(tools);

  await executeToolCalls({
    toolCalls: tools.map((tool) => createBatchToolCall(tool.name)),
    tools,
    assistantMessage,
    context,
    emit: () => undefined,
  });

  expect(order).toEqual(['A execute', 'B execute', 'C execute']);
});

it('stops sequential execution after an internal error', async () => {
  const secondExecute = vi.fn(async () => ({
    content: [{ type: 'text' as const, text: 'should not run' }],
  }));
  const firstTool = createBatchTool('A', async () => {
    throw new TypeError('secret failure');
  });
  const secondTool = createBatchTool('B', secondExecute);
  const { assistantMessage, context } = createBatchContext([firstTool, secondTool]);

  const outcome = await executeToolCalls({
    toolCalls: [createBatchToolCall('A'), createBatchToolCall('B')],
    tools: [firstTool, secondTool],
    assistantMessage,
    context,
    emit: () => undefined,
  });

  expect(outcome.stopReason).toBe('error');
  expect(outcome.messages).toHaveLength(1);
  expect(outcome.messages[0]).toMatchObject({
    details: { kind: 'internal', code: 'TOOL_INTERNAL_ERROR' },
  });
  expect(secondExecute).not.toHaveBeenCalled();
});

it('executes prepared tools concurrently in parallel mode', async () => {
  const deferred = new Map<string, ReturnType<typeof createDeferred<AgentToolResult>>>();
  const started = createDeferred<void>();
  let startedCount = 0;
  const tools = ['A', 'B'].map((name) => {
    const completion = createDeferred<AgentToolResult>();
    deferred.set(name, completion);
    return createBatchTool(name, async () => {
      startedCount += 1;
      if (startedCount === 2) started.resolve();
      const result = deferred.get(name);
      if (result === undefined) throw new Error(`Missing deferred tool ${name}.`);
      return await result.promise;
    });
  });
  const { assistantMessage, context } = createBatchContext(tools);
  const run = executeToolCalls({
    toolCalls: tools.map((tool) => createBatchToolCall(tool.name)),
    tools,
    assistantMessage,
    context,
    toolExecution: 'parallel',
    emit: () => undefined,
  });

  await started.promise;
  expect(startedCount).toBe(2);
  deferred.get('A')?.resolve({ content: [{ type: 'text', text: 'A' }] });
  deferred.get('B')?.resolve({ content: [{ type: 'text', text: 'B' }] });
  await run;
});

it('closes every started parallel ToolCall when the batch is aborted', async () => {
  const controller = new AbortController();
  const started = createDeferred<void>();
  let startedCount = 0;
  const tools = ['A', 'B'].map((name) =>
    createBatchTool(name, async (_callId, _args, signal) => {
      startedCount += 1;
      if (startedCount === 2) started.resolve();
      await new Promise<never>((_resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error('underlying cancellation'));
          return;
        }
        signal?.addEventListener('abort', () => reject(new Error('underlying cancellation')), {
          once: true,
        });
      });
      throw new Error('unreachable');
    }),
  );
  const { assistantMessage, context } = createBatchContext(tools);
  const run = executeToolCalls({
    toolCalls: tools.map((tool) => createBatchToolCall(tool.name)),
    tools,
    assistantMessage,
    context,
    toolExecution: 'parallel',
    signal: controller.signal,
    emit: () => undefined,
  });

  await started.promise;
  controller.abort();
  const outcome = await run;

  expect(outcome.stopReason).toBe('aborted');
  expect(outcome.messages).toHaveLength(2);
  expect(outcome.messages.map((message) => message.details)).toEqual([
    { kind: 'aborted', code: 'TOOL_ABORTED' },
    { kind: 'aborted', code: 'TOOL_ABORTED' },
  ]);
});

it('prepares parallel tool calls sequentially', async () => {
  const beforeOrder: string[] = [];
  const tools = ['A', 'B', 'C'].map((name) =>
    createBatchTool(name, async () => ({ content: [{ type: 'text', text: name }] })),
  );
  const { assistantMessage, context } = createBatchContext(tools);

  await executeToolCalls({
    toolCalls: tools.map((tool) => createBatchToolCall(tool.name)),
    tools,
    assistantMessage,
    context,
    toolExecution: 'parallel',
    beforeToolCall: ({ toolCall }) => {
      beforeOrder.push(toolCall.name);
      return undefined;
    },
    emit: () => undefined,
  });

  expect(beforeOrder).toEqual(['A', 'B', 'C']);
});

it('blocks a prepared parallel tool without executing or finalizing it', async () => {
  const executeSpies = new Map<string, ReturnType<typeof vi.fn<AgentTool['execute']>>>();
  const afterCalls: string[] = [];
  const tools = ['A', 'B', 'C'].map((name) => {
    const executeSpy = vi.fn<AgentTool['execute']>(async () => ({
      content: [{ type: 'text', text: name }],
    }));
    executeSpies.set(name, executeSpy);
    return createBatchTool(name, executeSpy);
  });
  const { assistantMessage, context } = createBatchContext(tools);
  const results = (await executeToolCalls({
    toolCalls: tools.map((tool) => createBatchToolCall(tool.name)),
    tools,
    assistantMessage,
    context,
    toolExecution: 'parallel',
    beforeToolCall: ({ toolCall }) =>
      toolCall.name === 'B' ? { block: true, reason: 'blocked' } : undefined,
    afterToolCall: ({ toolCall }) => {
      afterCalls.push(toolCall.name);
      return undefined;
    },
    emit: () => undefined,
  })).messages;

  expect(executeSpies.get('A')).toHaveBeenCalledTimes(1);
  expect(executeSpies.get('B')).not.toHaveBeenCalled();
  expect(executeSpies.get('C')).toHaveBeenCalledTimes(1);
  expect(afterCalls).toEqual(['A', 'C']);
  expect(results[1]?.isError).toBe(true);
});

it('emits parallel tool end events by completion order and returns source order results', async () => {
  const completions = new Map<string, ReturnType<typeof createDeferred<AgentToolResult>>>();
  const started = createDeferred<void>();
  let startedCount = 0;
  const tools = ['A', 'B', 'C'].map((name) => {
    const completion = createDeferred<AgentToolResult>();
    completions.set(name, completion);
    return createBatchTool(name, async () => {
      startedCount += 1;
      if (startedCount === 3) started.resolve();
      const result = completions.get(name);
      if (result === undefined) throw new Error(`Missing completion ${name}.`);
      return await result.promise;
    });
  });
  const { assistantMessage, context } = createBatchContext(tools);
  const endOrder: string[] = [];
  const run = executeToolCalls({
    toolCalls: tools.map((tool) => createBatchToolCall(tool.name)),
    tools,
    assistantMessage,
    context,
    toolExecution: 'parallel',
    emit: (event) => {
      if (event.type === 'tool_execution_end') endOrder.push(event.toolCall.name);
    },
  });

  await started.promise;
  completions.get('C')?.resolve({ content: [{ type: 'text', text: 'C' }] });
  await Promise.resolve();
  completions.get('A')?.resolve({ content: [{ type: 'text', text: 'A' }] });
  await Promise.resolve();
  completions.get('B')?.resolve({ content: [{ type: 'text', text: 'B' }] });

  const results = (await run).messages;
  expect(endOrder).toEqual(['C', 'A', 'B']);
  expect(results.map((result) => result.name)).toEqual(['A', 'B', 'C']);
});

it('finalizes parallel results and emits the finalized result', async () => {
  const tools = ['A', 'B'].map((name) =>
    createBatchTool(name, async () => ({ content: [{ type: 'text', text: `raw-${name}` }] })),
  );
  const { assistantMessage, context } = createBatchContext(tools);
  const endResults: ToolResultMessage[] = [];

  const results = (await executeToolCalls({
    toolCalls: tools.map((tool) => createBatchToolCall(tool.name)),
    tools,
    assistantMessage,
    context,
    toolExecution: 'parallel',
    afterToolCall: ({ toolCall }) => ({
      content: [{ type: 'text', text: `final-${toolCall.name}` }],
    }),
    emit: (event) => {
      if (event.type === 'tool_execution_end') endResults.push(event.result);
    },
  })).messages;

  expect(results.map((result) => result.content[0])).toEqual([
    { type: 'text', text: 'final-A' },
    { type: 'text', text: 'final-B' },
  ]);
  expect(endResults.map((result) => result.content[0])).toEqual([
    { type: 'text', text: 'final-A' },
    { type: 'text', text: 'final-B' },
  ]);
});

it('converts one parallel tool throw to an error without stopping other tools', async () => {
  const toolA = createBatchTool('A', async () => {
    throw new Error('A failed');
  });
  const toolB = createBatchTool('B', async () => ({
    content: [{ type: 'text', text: 'B succeeded' }],
  }));
  const { assistantMessage, context } = createBatchContext([toolA, toolB]);

  const results = await executeToolCalls({
    toolCalls: [createBatchToolCall('A'), createBatchToolCall('B')],
    tools: [toolA, toolB],
    assistantMessage,
    context,
    toolExecution: 'parallel',
    emit: () => undefined,
  });

  expect(results.stopReason).toBe('error');
  expect(results.messages[0]).toMatchObject({
    name: 'A',
    isError: true,
    content: [{ type: 'text', text: 'Tool execution failed due to an internal error.' }],
    details: { kind: 'internal', code: 'TOOL_INTERNAL_ERROR' },
  });
  expect(results.messages[1]).toMatchObject({ name: 'B', isError: false });
});
