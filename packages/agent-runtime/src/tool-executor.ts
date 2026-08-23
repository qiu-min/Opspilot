import {
  validateToolArguments,
  type AssistantMessage,
  type JsonObject,
  type ModelToolCall,
  type ToolResultMessage,
} from '@opspilot/model-gateway';
import type {
  AgentContext,
  AgentLoopConfig,
  AgentTool,
  AgentToolResult,
} from './types.js';

export interface ExecuteToolCallOptions {
  readonly assistantMessage: AssistantMessage;
  readonly context: AgentContext;
  readonly beforeToolCall?: AgentLoopConfig['beforeToolCall'];
  readonly afterToolCall?: AgentLoopConfig['afterToolCall'];
  readonly signal?: AbortSignal;
}

interface ExecutedToolCallOutcome {
  readonly result: AgentToolResult;
  readonly isError: boolean;
}

/** 执行一次模型工具调用，并完成 before/after Tool 策略阶段。
 * @param toolCall 模型请求执行的工具调用。
 * @param tools 当前上下文中允许使用的工具。
 * @param options 当前 assistant、AgentContext、策略 hook 和取消信号。
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

  let args: JsonObject;
  try {
    args = validateToolArguments(tool, toolCall);
  } catch (error: unknown) {
    return createToolErrorResult(toolCall, getErrorMessage(error));
  }

  if (options?.beforeToolCall !== undefined) {
    try {
      const decision = await options.beforeToolCall(
        {
          assistantMessage: options.assistantMessage,
          toolCall,
          args,
          context: options.context,
        },
        options.signal,
      );

      if (decision?.block === true) {
        return createToolErrorResult(
          toolCall,
          decision.reason ?? 'Tool execution was blocked.',
        );
      }
    } catch (error: unknown) {
      return createToolErrorResult(toolCall, getErrorMessage(error));
    }
  }

  let executed: ExecutedToolCallOutcome;
  try {
    const result = await tool.execute(toolCall.callId, args, options?.signal);
    executed = { result, isError: false };
  } catch (error: unknown) {
    executed = {
      result: {
        content: [{ type: 'text', text: getErrorMessage(error) }],
      },
      isError: true,
    };
  }

  let finalResult = executed.result;
  let finalIsError = executed.isError;
  if (options?.afterToolCall !== undefined) {
    try {
      const override = await options.afterToolCall(
        {
          assistantMessage: options.assistantMessage,
          toolCall,
          args,
          result: finalResult,
          isError: finalIsError,
          context: options.context,
        },
        options.signal,
      );

      if (override !== undefined) {
        finalResult = {
          ...finalResult,
          content: override.content ?? finalResult.content,
        };
        finalIsError = override.isError ?? finalIsError;
      }
    } catch (error: unknown) {
      return createToolErrorResult(toolCall, getErrorMessage(error));
    }
  }

  return createToolResult(toolCall, finalResult, finalIsError);
}

/** 创建最终的 ToolResultMessage。
 * @param toolCall 产生结果的模型工具调用。
 * @param result Tool 执行或策略覆盖后的内容结果。
 * @param isError 最终是否将本次 Tool execution 标记为失败。
 * @returns 标准 ToolResultMessage。
 */
function createToolResult(
  toolCall: ModelToolCall,
  result: AgentToolResult,
  isError: boolean,
): ToolResultMessage {
  return {
    role: 'tool',
    callId: toolCall.callId,
    name: toolCall.name,
    content: result.content,
    isError,
  };
}

/** 创建统一格式的可恢复 Tool error 结果。
 * @param toolCall 产生错误的模型工具调用。
 * @param message 展示给模型的错误文本。
 * @returns 标记为 isError 的 ToolResultMessage。
 */
function createToolErrorResult(toolCall: ModelToolCall, message: string): ToolResultMessage {
  return createToolResult(
    toolCall,
    { content: [{ type: 'text', text: message }] },
    true,
  );
}

/** 将未知异常转换成可展示的错误文本。
 * @param error Tool pipeline 中捕获的未知异常。
 * @returns 异常消息或其字符串表示。
 */
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
