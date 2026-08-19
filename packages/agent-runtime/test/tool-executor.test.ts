import { describe, expect, it, vi } from 'vitest';
import type { ModelToolCall } from '@opspilot/model-gateway';

import { executeToolCall } from '../src/tool-executor.js';
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