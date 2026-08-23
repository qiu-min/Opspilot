import {
  validateToolArguments,
  type AssistantMessage,
  type ModelToolCall,
  type ToolResultMessage,
} from '@opspilot/model-gateway';
import type { AgentContext, AgentLoopConfig, AgentTool } from './types.js';

export interface ExecuteToolCallOptions {
  readonly assistantMessage: AssistantMessage;
  readonly context: AgentContext;
  readonly beforeToolCall?: AgentLoopConfig['beforeToolCall'];
  readonly signal?: AbortSignal;
}

/** 执行一次模型工具调用，并在参数校验后运行可选的拦截 hook。
 * @param toolCall 模型请求执行的工具调用。
 * @param tools 当前上下文中允许使用的工具。
 * @param options 当前 assistant、AgentContext、拦截 hook 和取消信号。
 * @returns 成功结果或可恢复的 Tool error 结果。
 */
export async function executeToolCall(
  toolCall: ModelToolCall,
  tools: readonly AgentTool[],
  options?: ExecuteToolCallOptions,
): Promise<ToolResultMessage> {
  const tool = tools.find((candidate) => candidate.name === toolCall.name);

  if (tool === undefined) {
    return createToolErrorResult(toolCall, `Tool "${toolCall.name}" not found.`);
  }

  try {
    const args = validateToolArguments(tool, toolCall);
    const executionOptions = options;
    if (executionOptions?.beforeToolCall !== undefined) {
      const decision = await executionOptions.beforeToolCall(
        {
          assistantMessage: executionOptions.assistantMessage,
          toolCall,
          args,
          context: executionOptions.context,
        },
        executionOptions.signal,
      );

      if (decision?.block === true) {
        return createToolErrorResult(
          toolCall,
          decision.reason ?? 'Tool execution was blocked.',
        );
      }
    }

    const result = await tool.execute(toolCall.callId, args, options?.signal);

    return {
      role: 'tool',
      callId: toolCall.callId,
      name: toolCall.name,
      content: result.content,
      isError: false,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return createToolErrorResult(toolCall, message);
  }
}

/** 创建统一格式的可恢复 Tool error 结果。
 * @param toolCall 产生错误的模型工具调用。
 * @param message 展示给模型的错误文本。
 * @returns 标记为 isError 的 ToolResultMessage。
 */
function createToolErrorResult(toolCall: ModelToolCall, message: string): ToolResultMessage {
  return {
    role: 'tool',
    callId: toolCall.callId,
    name: toolCall.name,
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}
