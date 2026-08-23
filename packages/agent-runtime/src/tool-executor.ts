import {
  validateToolArguments,
  type AssistantMessage,
  type JsonObject,
  type ModelToolCall,
  type ToolResultMessage,
} from '@opspilot/model-gateway';
import type {
  AgentContext,
  AgentEventSink,
  AgentLoopConfig,
  AgentTool,
  AgentToolResult,
  ToolExecutionMode,
} from './types.js';

export interface ExecuteToolCallOptions {
  readonly assistantMessage: AssistantMessage;
  readonly context: AgentContext;
  readonly beforeToolCall?: AgentLoopConfig['beforeToolCall'];
  readonly afterToolCall?: AgentLoopConfig['afterToolCall'];
  readonly signal?: AbortSignal;
}

export interface ExecuteToolCallsOptions extends ExecuteToolCallOptions {
  readonly toolCalls: readonly ModelToolCall[];
  readonly tools: readonly AgentTool[];
  readonly toolExecution?: ToolExecutionMode;
  readonly emit: AgentEventSink;
  readonly onToolResult?: (
    toolCall: ModelToolCall,
    result: ToolResultMessage,
  ) => void | Promise<void>;
}

interface PreparedToolCall {
  readonly kind: 'prepared';
  readonly toolCall: ModelToolCall;
  readonly tool: AgentTool;
  readonly args: JsonObject;
}

interface ImmediateToolCallOutcome {
  readonly kind: 'immediate';
  readonly toolCall: ModelToolCall;
  readonly result: ToolResultMessage;
}

type ToolCallPreparation = PreparedToolCall | ImmediateToolCallOutcome;

interface ExecutedToolCallOutcome {
  readonly result: AgentToolResult;
  readonly isError: boolean;
}

type ParallelToolCallEntry =
  | ImmediateToolCallOutcome
  | {
      readonly kind: 'prepared';
      readonly preparation: PreparedToolCall;
    };

/** 执行一批模型工具调用，默认保持顺序执行。
 * @param options 工具调用、模型消息、工具集合、策略 hook、执行模式和事件出口。
 * @returns 按模型 ToolCall 原始顺序排列的 ToolResultMessage。
 */
export async function executeToolCalls(
  options: ExecuteToolCallsOptions,
): Promise<ToolResultMessage[]> {
  if (options.toolExecution === 'parallel') {
    return await executeToolCallsParallel(options);
  }

  return await executeToolCallsSequential(options);
}

/** 顺序准备并顺序执行所有工具调用。
 * @param options 当前批次的工具执行选项。
 * @returns 按输入顺序完成的 ToolResultMessage。
 */
async function executeToolCallsSequential(
  options: ExecuteToolCallsOptions,
): Promise<ToolResultMessage[]> {
  const results: ToolResultMessage[] = [];

  for (const toolCall of options.toolCalls) {
    if (options.signal?.aborted) break;

    await options.emit({ type: 'tool_execution_start', toolCall });
    const result = await executeToolCall(toolCall, options.tools, options);
    await options.emit({ type: 'tool_execution_end', toolCall, result });
    results.push(result);
    await options.onToolResult?.(toolCall, result);
  }

  return results;
}

/** 顺序准备工具，再并发执行已经允许执行的工具。
 * @param options 当前批次的工具执行选项。
 * @returns 按输入顺序排列、但按实际完成顺序发出结束事件的结果。
 */
async function executeToolCallsParallel(
  options: ExecuteToolCallsOptions,
): Promise<ToolResultMessage[]> {
  const entries: ParallelToolCallEntry[] = [];

  for (const toolCall of options.toolCalls) {
    if (options.signal?.aborted) break;

    await options.emit({ type: 'tool_execution_start', toolCall });
    const preparation = await prepareToolCall(toolCall, options.tools, options);
    if (preparation.kind === 'immediate') {
      await options.emit({
        type: 'tool_execution_end',
        toolCall,
        result: preparation.result,
      });
      entries.push(preparation);
    } else {
      entries.push({ kind: 'prepared', preparation });
    }
  }

  const results = await Promise.all(
    entries.map(async (entry) => {
      if (entry.kind === 'immediate') return entry.result;

      const executed = await executePreparedToolCall(entry.preparation, options.signal);
      const result = await finalizeExecutedToolCall(entry.preparation, executed, options);
      await options.emit({
        type: 'tool_execution_end',
        toolCall: entry.preparation.toolCall,
        result,
      });
      return result;
    }),
  );

  for (const [index, entry] of entries.entries()) {
    const result = results[index];
    if (result !== undefined) {
      const toolCall =
        entry.kind === 'immediate' ? entry.toolCall : entry.preparation.toolCall;
      await options.onToolResult?.(toolCall, result);
    }
  }

  return results;
}

/** 准备一个 ToolCall，只查找工具、校验参数并运行 before hook。
 * @param toolCall 模型请求执行的工具调用。
 * @param tools 当前上下文中允许使用的工具。
 * @param options 当前 assistant、上下文和 before hook 配置。
 * @returns 可执行的准备结果，或不进入 execute/after 阶段的立即错误。
 */
async function prepareToolCall(
  toolCall: ModelToolCall,
  tools: readonly AgentTool[],
  options?: ExecuteToolCallOptions,
): Promise<ToolCallPreparation> {
  const tool = tools.find((candidate) => candidate.name === toolCall.name);

  if (tool === undefined) {
    return {
      kind: 'immediate',
      toolCall,
      result: createToolErrorResult(toolCall, `Tool "${toolCall.name}" not found.`),
    };
  }

  let args: JsonObject;
  try {
    args = validateToolArguments(tool, toolCall);
  } catch (error: unknown) {
    return {
      kind: 'immediate',
      toolCall,
      result: createToolErrorResult(toolCall, getErrorMessage(error)),
    };
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
        return {
          kind: 'immediate',
          toolCall,
          result: createToolErrorResult(
            toolCall,
            decision.reason ?? 'Tool execution was blocked.',
          ),
        };
      }
    } catch (error: unknown) {
      return {
        kind: 'immediate',
        toolCall,
        result: createToolErrorResult(toolCall, getErrorMessage(error)),
      };
    }
  }

  return { kind: 'prepared', toolCall, tool, args };
}

/** 执行一个已准备好的 Tool，不负责 after hook 或消息封装。
 * @param prepared 已通过查找、参数校验和 before hook 的工具调用。
 * @param signal 当前 Agent Run 的取消信号。
 * @returns Tool 原始结果，以及是否由执行异常产生错误。
 */
async function executePreparedToolCall(
  prepared: PreparedToolCall,
  signal?: AbortSignal,
): Promise<ExecutedToolCallOutcome> {
  try {
    const result = await prepared.tool.execute(prepared.toolCall.callId, prepared.args, signal);
    return { result, isError: false };
  } catch (error: unknown) {
    return {
      result: {
        content: [{ type: 'text', text: getErrorMessage(error) }],
      },
      isError: true,
    };
  }
}

/** 运行 after hook，并将已执行结果封装成 ToolResultMessage。
 * @param prepared 已准备好的工具调用及参数。
 * @param executed Tool 执行结果和错误状态。
 * @param options 当前 assistant、上下文、after hook 和取消信号。
 * @returns 经过 after hook 覆盖后的标准 ToolResultMessage。
 */
async function finalizeExecutedToolCall(
  prepared: PreparedToolCall,
  executed: ExecutedToolCallOutcome,
  options?: ExecuteToolCallOptions,
): Promise<ToolResultMessage> {
  let finalResult = executed.result;
  let finalIsError = executed.isError;

  if (options?.afterToolCall !== undefined) {
    try {
      const override = await options.afterToolCall(
        {
          assistantMessage: options.assistantMessage,
          toolCall: prepared.toolCall,
          args: prepared.args,
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
      return createToolErrorResult(prepared.toolCall, getErrorMessage(error));
    }
  }

  return createToolResult(prepared.toolCall, finalResult, finalIsError);
}

/** 执行单个 ToolCall 的完整 prepare → execute → finalize 流程。
 * @param toolCall 模型请求执行的工具调用。
 * @param tools 当前上下文中允许使用的工具。
 * @param options 当前 assistant、上下文、策略 hook 和取消信号。
 * @returns 成功结果或可恢复的 Tool error 结果。
 */
export async function executeToolCall(
  toolCall: ModelToolCall,
  tools: readonly AgentTool[],
  options?: ExecuteToolCallOptions,
): Promise<ToolResultMessage> {
  const preparation = await prepareToolCall(toolCall, tools, options);
  if (preparation.kind === 'immediate') return preparation.result;

  const executed = await executePreparedToolCall(preparation, options?.signal);
  return await finalizeExecutedToolCall(preparation, executed, options);
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
