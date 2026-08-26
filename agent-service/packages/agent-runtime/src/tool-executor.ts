import {
  validateToolArguments,
  type AssistantMessage,
  type JsonObject,
  type ModelToolCall,
  type ToolResultMessage,
} from '@opspilot/model-gateway';
import {
  AgentToolExecutionError,
  type ToolErrorDetails,
} from './tool-errors.js';
import type {
  AgentContext,
  AgentEventSink,
  AgentLoopConfig,
  AgentTool,
  AgentToolResult,
  ToolExecutionMode,
} from './types.js';

const INTERNAL_ERROR_MESSAGE = 'Tool execution failed due to an internal error.';
const INTERNAL_ERROR_CODE = 'TOOL_INTERNAL_ERROR';
const ABORTED_ERROR_MESSAGE = 'Tool execution was aborted.';
const ABORTED_ERROR_CODE = 'TOOL_ABORTED';

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
}

interface PreparedToolCall {
  readonly kind: 'prepared';
  readonly toolCall: ModelToolCall;
  readonly tool: AgentTool;
  readonly args: JsonObject;
}

interface ToolCallOutcome {
  readonly result: ToolResultMessage;
  readonly stopReason?: 'error' | 'aborted';
  readonly cause?: unknown;
}

interface ToolCallBatchOutcome {
  readonly messages: ToolResultMessage[];
  readonly stopReason?: 'error' | 'aborted';
  readonly cause?: unknown;
}

interface ImmediateToolCallOutcome extends ToolCallOutcome {
  readonly kind: 'immediate';
  readonly toolCall: ModelToolCall;
}

type ToolCallPreparation = PreparedToolCall | ImmediateToolCallOutcome;

interface ExecutedToolCallOutcome {
  readonly result: AgentToolResult;
  readonly isError: boolean;
  readonly stopReason?: 'error' | 'aborted';
  readonly cause?: unknown;
}

type ParallelToolCallEntry =
  | ImmediateToolCallOutcome
  | {
      readonly kind: 'prepared';
      readonly preparation: PreparedToolCall;
    };

/** 供 Agent Loop 识别 Tool 批次终止原因的内部异常。 */
export class AgentToolBatchError extends Error {
  readonly outcome: ToolCallBatchOutcome;

  constructor(outcome: ToolCallBatchOutcome) {
    super(
      outcome.stopReason === 'aborted' ? ABORTED_ERROR_MESSAGE : INTERNAL_ERROR_MESSAGE,
      { cause: outcome.cause },
    );
    this.name = 'AgentToolBatchError';
    this.outcome = outcome;
  }
}

/** 执行一批模型工具调用，默认保持顺序执行。 */
export async function executeToolCalls(
  options: ExecuteToolCallsOptions,
): Promise<ToolCallBatchOutcome> {
  if (options.toolExecution === 'parallel') {
    return await executeToolCallsParallel(options);
  }

  return await executeToolCallsSequential(options);
}

/** 顺序准备并顺序执行所有工具调用。 */
async function executeToolCallsSequential(
  options: ExecuteToolCallsOptions,
): Promise<ToolCallBatchOutcome> {
  const messages: ToolResultMessage[] = [];

  for (const toolCall of options.toolCalls) {
    if (options.signal?.aborted) {
      return { messages, stopReason: 'aborted' };
    }

    await options.emit({ type: 'tool_execution_start', toolCall });
    const outcome = await executeToolCallWithOutcome(toolCall, options.tools, options);
    await options.emit({ type: 'tool_execution_end', toolCall, result: outcome.result });
    await emitToolResultMessage(outcome.result, options.emit);
    messages.push(outcome.result);

    if (outcome.stopReason !== undefined) {
      return {
        messages,
        stopReason: outcome.stopReason,
        ...(outcome.cause === undefined ? {} : { cause: outcome.cause }),
      };
    }
  }

  return { messages };
}

/** 顺序准备工具，再并发执行已经允许执行的工具。 */
async function executeToolCallsParallel(
  options: ExecuteToolCallsOptions,
): Promise<ToolCallBatchOutcome> {
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
      if (preparation.stopReason !== undefined) break;
    } else {
      entries.push({ kind: 'prepared', preparation });
    }
  }

  const outcomes = await Promise.all(
    entries.map(async (entry): Promise<ToolCallOutcome> => {
      if (entry.kind === 'immediate') return entry;

      const executed = await executePreparedToolCall(entry.preparation, options.signal);
      const outcome = await finalizeExecutedToolCall(entry.preparation, executed, options);
      await options.emit({
        type: 'tool_execution_end',
        toolCall: entry.preparation.toolCall,
        result: outcome.result,
      });
      return outcome;
    }),
  );

  const messages: ToolResultMessage[] = [];
  for (const outcome of outcomes) {
    await emitToolResultMessage(outcome.result, options.emit);
    messages.push(outcome.result);
  }

  const stopReason = getBatchStopReason(outcomes, options.signal);
  const cause = getBatchCause(outcomes, stopReason);
  return {
    messages,
    ...(stopReason === undefined ? {} : { stopReason }),
    ...(cause === undefined ? {} : { cause }),
  };
}

function getBatchStopReason(
  outcomes: readonly ToolCallOutcome[],
  signal?: AbortSignal,
): 'error' | 'aborted' | undefined {
  if (signal?.aborted || outcomes.some((outcome) => outcome.stopReason === 'aborted')) {
    return 'aborted';
  }
  if (outcomes.some((outcome) => outcome.stopReason === 'error')) return 'error';
  return undefined;
}

function getBatchCause(
  outcomes: readonly ToolCallOutcome[],
  stopReason: 'error' | 'aborted' | undefined,
): unknown {
  if (stopReason === undefined) return undefined;
  return outcomes.find((outcome) => outcome.stopReason === stopReason)?.cause;
}

/** 发布一个 ToolResult message 的生命周期事件，不修改 Agent Loop 上下文。 */
async function emitToolResultMessage(
  result: ToolResultMessage,
  emit: AgentEventSink,
): Promise<void> {
  await emit({ type: 'message_start', message: result });
  await emit({ type: 'message_end', message: result });
}

/** 准备一个 ToolCall，只查找工具、校验参数并运行 before hook。 */
async function prepareToolCall(
  toolCall: ModelToolCall,
  tools: readonly AgentTool[],
  options?: ExecuteToolCallOptions,
): Promise<ToolCallPreparation> {
  if (options?.signal?.aborted) {
    return createImmediateErrorOutcome(toolCall, classifyAbortedError());
  }

  const tool = tools.find((candidate) => candidate.name === toolCall.name);
  if (tool === undefined) {
    return createImmediateErrorOutcome(
      toolCall,
      createRecoverableError(`Tool "${toolCall.name}" not found.`, 'TOOL_NOT_FOUND'),
    );
  }

  let args: JsonObject;
  try {
    args = validateToolArguments(tool, toolCall);
  } catch (error: unknown) {
    return createImmediateErrorOutcome(
      toolCall,
      createRecoverableError(getErrorMessage(error), 'INVALID_TOOL_ARGUMENTS'),
    );
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

      if (options.signal?.aborted) {
        return createImmediateErrorOutcome(toolCall, classifyAbortedError());
      }
      if (decision?.block === true) {
        return createImmediateErrorOutcome(
          toolCall,
          createRecoverableError(
            decision.reason ?? 'Tool execution was blocked.',
            'TOOL_BLOCKED',
          ),
        );
      }
    } catch (error: unknown) {
      return createImmediateErrorOutcome(toolCall, classifyThrownError(error, options.signal));
    }
  }

  return { kind: 'prepared', toolCall, tool, args };
}

/** 执行一个已准备好的 Tool，不负责 after hook 或消息封装。 */
async function executePreparedToolCall(
  prepared: PreparedToolCall,
  signal?: AbortSignal,
): Promise<ExecutedToolCallOutcome> {
  if (signal?.aborted) return createExecutedErrorOutcome(classifyAbortedError());

  try {
    const result = await prepared.tool.execute(prepared.toolCall.callId, prepared.args, signal);
    if (signal?.aborted) return createExecutedErrorOutcome(classifyAbortedError());
    return { result, isError: false };
  } catch (error: unknown) {
    return createExecutedErrorOutcome(classifyThrownError(error, signal));
  }
}

/** 运行 after hook，并将已执行结果封装成 ToolResultMessage。 */
async function finalizeExecutedToolCall(
  prepared: PreparedToolCall,
  executed: ExecutedToolCallOutcome,
  options?: ExecuteToolCallOptions,
): Promise<ToolCallOutcome> {
  if (executed.stopReason !== undefined) {
    return createToolCallOutcome(prepared.toolCall, executed.result, executed);
  }

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

      if (options.signal?.aborted) {
        return createToolCallOutcome(
          prepared.toolCall,
          createAgentToolErrorResult(classifyAbortedError()),
          { stopReason: 'aborted' },
        );
      }
      if (override !== undefined) {
        finalResult = {
          ...finalResult,
          content: override.content ?? finalResult.content,
          ...(override.details === undefined ? {} : { details: override.details }),
        };
        finalIsError = override.isError ?? finalIsError;
      }
    } catch (error: unknown) {
      const classified = classifyThrownError(error, options.signal);
      return createToolCallOutcome(
        prepared.toolCall,
        createAgentToolErrorResult(classified),
        classified,
      );
    }
  }

  return {
    result: createToolResult(prepared.toolCall, finalResult, finalIsError),
  };
}

/** 执行单个 ToolCall 的完整 prepare → execute → finalize 流程。 */
export async function executeToolCall(
  toolCall: ModelToolCall,
  tools: readonly AgentTool[],
  options?: ExecuteToolCallOptions,
): Promise<ToolResultMessage> {
  const outcome = await executeToolCallWithOutcome(toolCall, tools, options);
  return outcome.result;
}

async function executeToolCallWithOutcome(
  toolCall: ModelToolCall,
  tools: readonly AgentTool[],
  options?: ExecuteToolCallOptions,
): Promise<ToolCallOutcome> {
  const preparation = await prepareToolCall(toolCall, tools, options);
  if (preparation.kind === 'immediate') return preparation;

  const executed = await executePreparedToolCall(preparation, options?.signal);
  return await finalizeExecutedToolCall(preparation, executed, options);
}

function createImmediateErrorOutcome(
  toolCall: ModelToolCall,
  classified: ClassifiedToolError,
): ImmediateToolCallOutcome {
  return {
    kind: 'immediate',
    toolCall,
    result: createToolErrorResult(toolCall, classified),
    ...(classified.stopReason === undefined ? {} : { stopReason: classified.stopReason }),
    ...(classified.cause === undefined ? {} : { cause: classified.cause }),
  };
}

function createExecutedErrorOutcome(
  classified: ClassifiedToolError,
): ExecutedToolCallOutcome {
  return {
    result: createAgentToolErrorResult(classified),
    isError: true,
    ...(classified.stopReason === undefined ? {} : { stopReason: classified.stopReason }),
    ...(classified.cause === undefined ? {} : { cause: classified.cause }),
  };
}

function createToolCallOutcome(
  toolCall: ModelToolCall,
  result: AgentToolResult | ToolResultMessage,
  outcome: Pick<ClassifiedToolError, 'stopReason' | 'cause'>,
): ToolCallOutcome {
  return {
    result: isToolResultMessage(result)
      ? result
      : createToolResult(toolCall, result, true),
    ...(outcome.stopReason === undefined ? {} : { stopReason: outcome.stopReason }),
    ...(outcome.cause === undefined ? {} : { cause: outcome.cause }),
  };
}

interface ClassifiedToolError {
  readonly message: string;
  readonly details: ToolErrorDetails;
  readonly stopReason?: 'error' | 'aborted';
  readonly cause?: unknown;
}

function classifyThrownError(error: unknown, signal?: AbortSignal): ClassifiedToolError {
  if (signal?.aborted) return classifyAbortedError(error);
  if (error instanceof AgentToolExecutionError) {
    return {
      message: error.message,
      details: {
        kind: 'recoverable',
        code: error.code,
        ...(error.data === undefined ? {} : { data: error.data }),
      },
    };
  }
  return {
    message: INTERNAL_ERROR_MESSAGE,
    details: { kind: 'internal', code: INTERNAL_ERROR_CODE },
    stopReason: 'error',
    cause: error,
  };
}

function classifyAbortedError(cause?: unknown): ClassifiedToolError {
  return {
    message: ABORTED_ERROR_MESSAGE,
    details: { kind: 'aborted', code: ABORTED_ERROR_CODE },
    stopReason: 'aborted',
    ...(cause === undefined ? {} : { cause }),
  };
}

function createRecoverableError(
  message: string,
  code: string,
  data?: unknown,
): ClassifiedToolError {
  return {
    message,
    details: {
      kind: 'recoverable',
      code,
      ...(data === undefined ? {} : { data }),
    },
  };
}

function createToolErrorResult(
  toolCall: ModelToolCall,
  classified: ClassifiedToolError,
): ToolResultMessage {
  return createToolResult(toolCall, createAgentToolErrorResult(classified), true);
}

function createAgentToolErrorResult(classified: ClassifiedToolError): AgentToolResult {
  return {
    content: [{ type: 'text', text: classified.message }],
    details: classified.details,
  };
}

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
    ...(result.details === undefined ? {} : { details: result.details }),
    isError,
  };
}

function isToolResultMessage(
  result: AgentToolResult | ToolResultMessage,
): result is ToolResultMessage {
  return 'role' in result && result.role === 'tool';
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
