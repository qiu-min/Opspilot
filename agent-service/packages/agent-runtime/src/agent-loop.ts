import type {
  AgentContext,
  AgentEventSink,
  AgentLoopConfig,
  AgentMessage,
  AgentTool,
  StreamFn,
} from './types.js';
import type { AssistantMessage, Context, Tool, ToolResultMessage } from '@opspilot/model-gateway';
import type { Options } from '@opspilot/model-gateway';
import { executeToolCalls } from './tool-executor.js';
import { defaultConvertToLlm } from './convert-to-llm.js';

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
): Promise<AgentLoopOutcome> {
  const newMessages: AgentMessage[] = [...prompts];
  const currentContext: AgentContext = {
    ...context,
    messages: [...context.messages, ...prompts],
  };

  await emit({ type: 'agent_start' });

  await emit({ type: 'turn_start' });

  for (const prompt of prompts) {
    await emit({ type: 'message_start', message: prompt });
    await emit({ type: 'message_end', message: prompt });
  }

  const termination = await runLoop(currentContext, newMessages, config, streamFn, emit, signal);

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
  signal?: AbortSignal,
): Promise<AgentLoopTermination | undefined> {
  let currentContext = initialContext;
  let config = initialConfig;
  const initialSteeringMessages = await config.getSteeringMessages?.(signal);
  let pendingMessages: AgentMessage[] = [...(initialSteeringMessages ?? [])];
  let firstTurn = true;

  while (true) {
    let hasMoreToolCalls = true;

    while (hasMoreToolCalls || pendingMessages.length > 0) {
      if (firstTurn) {
        firstTurn = false;
      } else {
        await emit({ type: 'turn_start' });
      }

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
        signal,
      );
      newMessages.push(assistantMessage);

      if (
        assistantMessage.finishReason === 'error' ||
        assistantMessage.finishReason === 'aborted'
      ) {
        await emit({
          type: 'turn_end',
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
        type: 'turn_end',
        message: assistantMessage,
        toolResults,
      });

      const nextTurnUpdate = await config.prepareNextTurn?.(
        {
          message: assistantMessage,
          toolResults,
          context: currentContext,
          newMessages,
        },
        signal,
      );
      if (nextTurnUpdate?.context !== undefined) {
        currentContext = nextTurnUpdate.context;
      }
      if (nextTurnUpdate?.model !== undefined) {
        config = {
          ...config,
          model: nextTurnUpdate.model,
        };
      }

      const shouldStop = await config.shouldStopAfterTurn?.({
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
  signal?: AbortSignal,
): Promise<AssistantMessage> {
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

  /** 完成最终 assistant 消息的上下文替换和生命周期事件。
   * @param finalMessage 模型正常完成或失败终止时的最终消息。
   * @returns 已完成生命周期的最终 assistant 消息。
   */
  const finalizeMessage = async (finalMessage: AssistantMessage): Promise<AssistantMessage> => {
    if (addedPartial) context.messages[context.messages.length - 1] = finalMessage;
    else {
      context.messages.push(finalMessage);
      await emit({ type: 'message_start', message: { ...finalMessage } });
    }

    await emit({ type: 'message_end', message: finalMessage });
    return finalMessage;
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
      case 'usage':
        partialMessage = event.partial;
        if (addedPartial) context.messages[context.messages.length - 1] = partialMessage;
        await emit({ type: 'message_update', event, message: partialMessage });
        break;
      case 'done':
        return await finalizeMessage(event.response);
      case 'error':
        return await finalizeMessage(event.error);
    }
  }

  return await finalizeMessage(await stream.result());
}
