import type {
  AgentContext,
  AgentEventSink,
  AgentLoopConfig,
  AgentMessage,
  AgentToolCallContinuation,
  AgentTool,
  StreamFn,
} from './types.js';
import type {
  AssistantMessage,
  Context,
  Tool,
  ToolResultMessage,
} from '@opspilot/model-gateway';
import type { Options } from '@opspilot/model-gateway';
import { randomUUID } from 'node:crypto';
import { executeToolCalls } from './tool-executor.js';
import { defaultConvertToLlm } from './convert-to-llm.js';
import type { Usage } from '@opspilot/model-gateway';
import {
  markAgentSpanAborted,
  markAgentSpanError,
  type AgentSpan,
  withAgentSpan,
} from './tracing.js';

/** Project executable AgentTools into the strict model-gateway Tool contract. */
function toModelTools(tools: readonly AgentTool[] | undefined): readonly Tool[] | undefined {
  if (tools === undefined) return undefined;

  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

export interface AgentLoopTermination {
  readonly reason: 'error' | 'aborted';
  readonly message: string;
  readonly cause?: unknown;
  readonly toolResults: readonly ToolResultMessage[];
}

export interface AgentLoopOutcome {
  readonly messages: AgentMessage[];
  readonly termination?: AgentLoopTermination;
}

/**
 * 启动一次 Agent 运行并发出生命周期事件。
 * @param prompts 本次运行新增的消息。
 * @param context 当前 Agent 的系统提示词、历史消息和工具上下文。
 * @param config 当前运行的模型和循环配置。
 * @param streamFn 创建模型事件流的函数。
 * @param emit 接收 AgentEvent 的事件接收器。
 * @param signal 用于取消模型请求的信号。
 */
export async function runAgentLoop(
  prompts: readonly AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig,
  streamFn: StreamFn,
  emit: AgentEventSink,
  signal?: AbortSignal,
): Promise<AgentMessage[]> {
  const outcome = await runAgentLoopWithOutcome(prompts, context, config, streamFn, emit, signal);
  return outcome.messages;
}

/** 启动一次 Agent 运行，并显式返回工具批次的终止结果。 */
export async function runAgentLoopWithOutcome(
  prompts: readonly AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig,
  streamFn: StreamFn,
  emit: AgentEventSink,
  signal?: AbortSignal,
  continuation?: AgentToolCallContinuation,
): Promise<AgentLoopOutcome> {
  return await withAgentSpan(config.tracer, 'agent.run', {}, async (span) => {
    try {
      const outcome = await runAgentLoopWithOutcomeBody(
        prompts,
        context,
        config,
        streamFn,
        emit,
        signal,
        continuation,
      );
      if (outcome.termination !== undefined) {
        if (outcome.termination.reason === 'aborted') {
          markAgentSpanAborted(span, outcome.termination.message);
        } else {
          markAgentSpanError(
            span,
            outcome.termination.cause ?? new Error(outcome.termination.message),
          );
        }
      } else {
        const lastMessage = outcome.messages.at(-1);
        if (
          lastMessage?.role === 'assistant' &&
          (lastMessage.finishReason === 'error' || lastMessage.finishReason === 'aborted')
        ) {
          if (lastMessage.finishReason === 'aborted') {
            markAgentSpanAborted(span, lastMessage.errorMessage);
          } else {
            markAgentSpanError(span, new Error(lastMessage.errorMessage ?? 'Model call failed.'));
          }
        } else {
          span.setStatus('ok');
        }
      }
      return outcome;
    } catch (error: unknown) {
      markAgentSpanError(span, error, { aborted: signal?.aborted });
      throw error;
    }
  });
}

/** Executes the Agent Loop body inside the root tracing scope. */
async function runAgentLoopWithOutcomeBody(
  prompts: readonly AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig,
  streamFn: StreamFn,
  emit: AgentEventSink,
  signal?: AbortSignal,
  continuation?: AgentToolCallContinuation,
): Promise<AgentLoopOutcome> {
  const newMessages: AgentMessage[] = [...prompts];
  const currentContext: AgentContext = {
    ...context,
    messages: [...context.messages, ...prompts],
  };

  await emit({ type: 'agent_start' });

  if (continuation !== undefined) {
    const outcome = await executeToolCalls({
      toolCalls: continuation.toolCalls,
      tools: currentContext.tools ?? [],
      assistantMessage: continuation.assistantMessage,
      context: currentContext,
      beforeToolCall: config.beforeToolCall,
      afterToolCall: config.afterToolCall,
      toolExecution: config.toolExecution,
      tracer: config.tracer,
      signal,
      emit,
    });
    for (const result of outcome.messages) {
      currentContext.messages.push(result);
      newMessages.push(result);
    }
    if (outcome.stopReason !== undefined) {
      return {
        messages: newMessages,
        termination: {
          reason: outcome.stopReason,
          message:
            outcome.stopReason === 'aborted'
              ? 'Tool execution was aborted.'
              : 'Tool execution failed due to an internal error.',
          ...(outcome.cause === undefined ? {} : { cause: outcome.cause }),
          toolResults: outcome.messages,
        },
      };
    }
  }

  const initialModelCallId = randomUUID();
  await emit({ type: 'step_start', modelCallId: initialModelCallId });

  for (const prompt of prompts) {
    await emit({ type: 'message_start', message: prompt });
    await emit({ type: 'message_end', message: prompt });
  }

  const termination = await runLoop(
    currentContext,
    newMessages,
    config,
    streamFn,
    emit,
    initialModelCallId,
    signal,
  );

  return {
    messages: newMessages,
    ...(termination === undefined ? {} : { termination }),
  };
}

/**
 * 执行模型回合、工具调用和后续回合，直到 Agent 正常结束。
 * @param initialContext 当前运行开始时的消息上下文。
 * @param newMessages 本次运行新增的消息集合。
 * @param initialConfig 当前运行开始时的模型和循环配置。
 * @param streamFn 创建模型事件流的函数。
 * @param emit 接收 AgentEvent 的事件接收器。
 * @param signal 用于取消模型请求和工具执行的信号。
 */
async function runLoop(
  initialContext: AgentContext,
  newMessages: AgentMessage[],
  initialConfig: AgentLoopConfig,
  streamFn: StreamFn,
  emit: AgentEventSink,
  initialModelCallId: string,
  signal?: AbortSignal,
): Promise<AgentLoopTermination | undefined> {
  let currentContext = initialContext;
  let config = initialConfig;
  const initialSteeringMessages = await config.getSteeringMessages?.(signal);
  let pendingMessages: AgentMessage[] = [...(initialSteeringMessages ?? [])];
  let firstStep = true;
  let nextModelCallId: string | undefined = initialModelCallId;

  while (true) {
    let hasMoreToolCalls = true;

    while (hasMoreToolCalls || pendingMessages.length > 0) {
      const modelCallId = nextModelCallId ?? randomUUID();
      nextModelCallId = undefined;
      if (firstStep) firstStep = false;
      else await emit({ type: 'step_start', modelCallId });

      for (const pendingMessage of pendingMessages) {
        currentContext.messages.push(pendingMessage);
        newMessages.push(pendingMessage);
        await emit({ type: 'message_start', message: pendingMessage });
        await emit({ type: 'message_end', message: pendingMessage });
      }
      pendingMessages = [];

      //signal?.throwIfAborted();
      const assistantMessage = await streamAssistantResponse(
        currentContext,
        config,
        streamFn,
        emit,
        modelCallId,
        signal,
      );
      newMessages.push(assistantMessage);

      if (
        assistantMessage.finishReason === 'error' ||
        assistantMessage.finishReason === 'aborted'
      ) {
        await emit({
          type: 'step_end',
          message: assistantMessage,
          toolResults: [],
        });
        await emit({ type: 'agent_end', messages: newMessages });
        return undefined;
      }

      const toolCalls = assistantMessage.toolCalls ?? [];
      const toolResults: ToolResultMessage[] = [];

      if (assistantMessage.finishReason === 'tool_calls' && toolCalls.length > 0) {
        const outcome = await executeToolCalls({
          toolCalls,
          tools: currentContext.tools ?? [],
          assistantMessage,
          context: currentContext,
          beforeToolCall: config.beforeToolCall,
          afterToolCall: config.afterToolCall,
          toolExecution: config.toolExecution,
          tracer: config.tracer,
          signal,
          emit,
        });

        for (const result of outcome.messages) {
          toolResults.push(result);
          currentContext.messages.push(result);
          newMessages.push(result);
        }

        if (outcome.stopReason !== undefined) {
          return {
            reason: outcome.stopReason,
            message:
              outcome.stopReason === 'aborted'
                ? 'Tool execution was aborted.'
                : 'Tool execution failed due to an internal error.',
            ...(outcome.cause === undefined ? {} : { cause: outcome.cause }),
            toolResults,
          };
        }
      }

      await emit({
        type: 'step_end',
        message: assistantMessage,
        toolResults,
      });

      const nextStepUpdate = await config.prepareNextStep?.(
        {
          message: assistantMessage,
          toolResults,
          context: currentContext,
          newMessages,
        },
        signal,
      );
      if (nextStepUpdate?.context !== undefined) {
        currentContext = nextStepUpdate.context;
      }
      if (nextStepUpdate?.model !== undefined) {
        config = {
          ...config,
          model: nextStepUpdate.model,
        };
      }

      const shouldStop = await config.shouldStopAfterStep?.({
        message: assistantMessage,
        toolResults,
        context: currentContext,
        newMessages,
      });
      if (shouldStop) {
        await emit({ type: 'agent_end', messages: newMessages });
        return undefined;
      }

      hasMoreToolCalls = assistantMessage.finishReason === 'tool_calls' && toolCalls.length > 0;
      const steeringMessages = await config.getSteeringMessages?.(signal);
      pendingMessages = [...(steeringMessages ?? [])];
    }

    const followUpMessages = await config.getFollowUpMessages?.(signal);
    pendingMessages = [...(followUpMessages ?? [])];
    if (pendingMessages.length === 0) break;
  }

  await emit({ type: 'agent_end', messages: newMessages });
  return undefined;
}

/**
 * 消费模型事件并映射为 Agent 消息生命周期事件。
 * @param context 当前 Agent 的系统提示词、消息和工具上下文。
 * @param config 当前回合使用的模型配置。
 * @param streamFn 创建模型事件流的函数。
 * @param emit 接收映射后 AgentEvent 的事件接收器。
 * @param signal 用于取消模型请求的信号。
 */
async function streamAssistantResponse(
  context: AgentContext,
  config: AgentLoopConfig,
  streamFn: StreamFn,
  emit: AgentEventSink,
  modelCallId: string,
  signal?: AbortSignal,
): Promise<AssistantMessage> {
  return await withAgentSpan(
    config.tracer,
    'agent.model_call',
    {
      attributes: {
        'agent.model_call.id': modelCallId,
        'agent.model_call.provider': config.model.provider,
        'agent.model_call.model': config.model.id,
      },
    },
    async (span) => {
      try {
        const outcome = await consumeAssistantResponse(
          context,
          config,
          streamFn,
          emit,
          modelCallId,
          signal,
        );
        if (outcome.usage !== undefined) setModelUsage(span, outcome.usage);
        if (outcome.message.finishReason === 'error') {
          markAgentSpanError(span, new Error(outcome.message.errorMessage ?? 'Model call failed.'));
        } else if (outcome.message.finishReason === 'aborted') {
          markAgentSpanAborted(span, outcome.message.errorMessage);
        } else {
          span.setStatus('ok');
        }
        return outcome.message;
      } catch (error: unknown) {
        markAgentSpanError(span, error, { aborted: signal?.aborted });
        throw error;
      }
    },
  );
}

interface AssistantResponseOutcome {
  readonly message: AssistantMessage;
  readonly usage?: Usage;
}

/** Consumes the complete model stream and maps it to Agent message events. */
async function consumeAssistantResponse(
  context: AgentContext,
  config: AgentLoopConfig,
  streamFn: StreamFn,
  emit: AgentEventSink,
  modelCallId: string,
  signal?: AbortSignal,
): Promise<AssistantResponseOutcome> {
  const sourceMessages = context.messages;
  const transformedMessages = config.transformContext
    ? await config.transformContext(sourceMessages, signal)
    : sourceMessages;
  const convertToLlm = config.convertToLlm ?? defaultConvertToLlm;
  const llmMessages = await convertToLlm(transformedMessages);
  const llmContext: Context = {
    systemPrompt: context.systemPrompt,
    messages: [...llmMessages],
    tools: toModelTools(context.tools),
  };
  const options: Options =
    config.thinkingLevel === undefined || config.thinkingLevel === 'off'
      ? { signal }
      : { signal, reasoning: config.thinkingLevel };
  const stream = streamFn(config.model, llmContext, options);
  let partialMessage: AssistantMessage | null = null;
  let addedPartial = false;
  let observedUsage: Usage | undefined;

  /** 完成最终 assistant 消息的上下文替换和生命周期事件。
   * @param finalMessage 模型正常完成或失败终止时的最终消息。
   * @returns 已完成生命周期的最终 assistant 消息。
   */
  const finalizeMessage = async (
    finalMessage: AssistantMessage,
  ): Promise<AssistantResponseOutcome> => {
    if (addedPartial) context.messages[context.messages.length - 1] = finalMessage;
    else {
      context.messages.push(finalMessage);
      await emit({ type: 'message_start', message: { ...finalMessage } });
    }

    await emit({ type: 'message_end', message: finalMessage, modelCallId });
    return {
      message: finalMessage,
      usage: finalMessage.usage ?? observedUsage,
    };
  };

  for await (const event of stream) {
    switch (event.type) {
      case 'start':
        partialMessage = event.partial;
        context.messages.push(partialMessage);
        addedPartial = true;
        await emit({ type: 'message_start', message: { ...partialMessage } });
        break;
      case 'text.delta':
      case 'thinking.delta':
      case 'tool-call.delta':
      case 'tool-call.completed':
        partialMessage = event.partial;
        if (addedPartial) context.messages[context.messages.length - 1] = partialMessage;
        await emit({ type: 'message_update', event, message: partialMessage });
        break;
      case 'usage':
        partialMessage = event.partial;
        observedUsage = event.usage;
        if (addedPartial) context.messages[context.messages.length - 1] = partialMessage;
        await emit({ type: 'message_update', event, message: partialMessage });
        break;
      case 'retry':
        await emit({
          type: 'model_retry',
          modelCallId,
          failedAttempt: event.failedAttempt,
          nextAttempt: event.nextAttempt,
          delayMs: event.delayMs,
          error: event.error,
        });
        break;
      case 'done':
        return await finalizeMessage(event.response);
      case 'error':
        return await finalizeMessage(event.error);
    }
  }

  return await finalizeMessage(await stream.result());
}

/** Writes model token usage using stable, provider-neutral Runtime attributes. */
function setModelUsage(span: AgentSpan, usage: Usage): void {
  span.setAttributes({
    'agent.model_call.input_tokens': usage.inputTokens,
    'agent.model_call.output_tokens': usage.outputTokens,
    'agent.model_call.total_tokens': usage.totalTokens,
  });
}
