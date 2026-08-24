import { describe, expect, it } from 'vitest';
import type {
  AssistantMessage,
  ModelToolCall,
  ToolResultMessage,
} from '../../model-gateway/src/contracts/context.js';

import { executeToolCall } from '../../agent-runtime/src/tool-executor.js';
import type { AgentContext, AgentTool } from '../../agent-runtime/src/types.js';
import {
  FixtureLogConnector,
  queryLogsInputSchema,
  type LogConnector,
} from '../src/index.js';

const assistantMessage: AssistantMessage = {
  role: 'assistant',
  api: 'test-api',
  provider: 'test-provider',
  model: 'test-model',
  content: [],
  finishReason: 'tool_calls',
};

/** 创建通过 Connector 访问日志的 AgentTool Adapter。
 * @param connector 提供日志查询能力的 Connector。
 * @returns 可由 agent-runtime 执行的 AgentTool。
 */
function createQueryLogsTool(connector: LogConnector): AgentTool {
  return {
    name: 'queryLogs',
    description: 'Query service logs in a time range.',
    parameters: {
      type: 'object',
      properties: {
        service: { type: 'string' },
        startTime: { type: 'string' },
        endTime: { type: 'string' },
        query: { type: 'string' },
      },
      required: ['service', 'startTime', 'endTime'],
      additionalProperties: false,
    },
    async execute(_callId, args, signal) {
      const input = queryLogsInputSchema.parse(args);
      const result = await connector.query(input, signal);
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    },
  };
}

/** 创建执行单个工具调用所需的 Agent Context。
 * @param tool 可执行的 AgentTool。
 * @returns 包含 assistant 消息和工具的 Agent Context。
 */
function createContext(tool: AgentTool): AgentContext {
  return {
    messages: [assistantMessage],
    tools: [tool],
  };
}

/** 创建测试用的 ModelToolCall。
 * @param service 工具请求查询的服务名称。
 * @returns 标准模型工具调用。
 */
function createToolCall(service: string): ModelToolCall {
  return {
    callId: `logs-${service}`,
    name: 'queryLogs',
    arguments: {
      service,
      startTime: '2026-08-13T10:00:00.000Z',
      endTime: '2026-08-13T10:15:00.000Z',
      query: 'timeout',
    },
  };
}

describe('AgentTool and Fixture Connector integration', () => {
  it('executes ModelToolCall through AgentTool and returns a successful ToolResultMessage', async () => {
    const tool = createQueryLogsTool(new FixtureLogConnector());
    const toolCall = createToolCall('billing-api');
    const result: ToolResultMessage = await executeToolCall(toolCall, [tool], {
      assistantMessage,
      context: createContext(tool),
    });

    expect(result).toMatchObject({
      role: 'tool',
      name: 'queryLogs',
      callId: toolCall.callId,
      isError: false,
    });
    expect(result.content[0]).toMatchObject({ type: 'text' });
    expect((result.content[0] as { type: 'text'; text: string }).text).toContain(
      'database connection acquisition timeout',
    );
  });

  it('lets agent-runtime convert Connector errors into an error ToolResultMessage', async () => {
    const tool = createQueryLogsTool(new FixtureLogConnector());
    const toolCall = createToolCall('missing-api');
    const result = await executeToolCall(toolCall, [tool], {
      assistantMessage,
      context: createContext(tool),
    });

    expect(result).toMatchObject({
      role: 'tool',
      name: 'queryLogs',
      callId: toolCall.callId,
      isError: true,
    });
    expect((result.content[0] as { type: 'text'; text: string }).text).toContain(
      'No fixture service named missing-api.',
    );
  });
});
