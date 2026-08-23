import { describe, expect, it, vi } from 'vitest';
import type { AssistantMessage, ModelToolCall } from '@opspilot/model-gateway';

import { executeToolCall, type ExecuteToolCallOptions } from '../src/tool-executor.js';
import type { AgentTool } from '../src/types.js';

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
): ExecuteToolCallOptions {
  return {
    assistantMessage,
    context: {
      messages: [],
      tools: [tool],
    },
    ...(beforeToolCall === undefined ? {} : { beforeToolCall }),
    ...(afterToolCall === undefined ? {} : { afterToolCall }),
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
  expect(execute).not.toHaveBeenCalled();
});

it('converts beforeToolCall exceptions into recoverable Tool errors', async () => {
  execute.mockClear();

  const result = await executeToolCall(
    toolCall,
    [tool],
    createExecutionOptions(() => {
      throw new Error('policy failed');
    }),
  );

  expect(result.isError).toBe(true);
  expect(result.content).toEqual([{ type: 'text', text: 'policy failed' }]);
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

it('passes tool execution errors through afterToolCall before finalizing', async () => {
  execute.mockClear();
  execute.mockRejectedValue(new Error('ECONNREFUSED'));
  let receivedIsError: boolean | undefined;
  let receivedContent: readonly { type: 'text'; text: string }[] | undefined;

  const result = await executeToolCall(
    toolCall,
    [tool],
    createExecutionOptions(undefined, ({ result: executed, isError }) => {
      receivedIsError = isError;
      receivedContent = executed.content;
      return {
        content: [{ type: 'text', text: '日志服务暂时不可用。' }],
      };
    }),
  );

  expect(receivedIsError).toBe(true);
  expect(receivedContent).toEqual([{ type: 'text', text: 'ECONNREFUSED' }]);
  expect(result.content).toEqual([{ type: 'text', text: '日志服务暂时不可用。' }]);
  expect(result.isError).toBe(true);
});

it('converts afterToolCall exceptions into recoverable Tool errors', async () => {
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
  expect(result.content).toEqual([{ type: 'text', text: 'result policy failed' }]);
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
