import type {
  AgentContext,
  AgentEventSink,
  AgentLoopConfig,
  AgentMessage,
  StreamFn,
} from './types.js';
import type { Context, ToolResultMessage } from '@opspilot/model-gateway';
import { executeToolCall } from './tool-executor.js';
import { defaultConvertToLlm } from './convert-to-llm.js';

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

  await runLoop(currentContext, newMessages, config, streamFn, emit, signal);

  return newMessages;
}

/**
 * 执行模型回合、工具调用和后续回合，直到 Agent 正常结束。
 * @param context 当前运行中维护的完整消息上下文。
 * @param newMessages 本次运行新增的消息集合。
 * @param config 当前运行的模型和循环配置。
 * @param streamFn 创建模型事件流的函数。
 * @param emit 接收 AgentEvent 的事件接收器。
 * @param signal 用于取消模型请求和工具执行的信号。
 */
async function runLoop(
  context: AgentContext,
  newMessages: AgentMessage[],
  config: AgentLoopConfig,
  streamFn: StreamFn,
  emit: AgentEventSink,
  signal?: AbortSignal,
): Promise<void> {
  while (true) {
    //signal?.throwIfAborted();
    const assistantMessage = await streamAssistantResponse(context, config, streamFn, emit, signal);
    context.messages.push(assistantMessage);
    newMessages.push(assistantMessage);

    const toolCalls = assistantMessage.toolCalls ?? [];
    const toolResults: ToolResultMessage[] = [];

    if (assistantMessage.finishReason === 'tool_calls' && toolCalls.length > 0) {
      for (const toolCall of toolCalls) {
        await emit({ type: 'tool_execution_start', toolCall });

        const result = await executeToolCall(toolCall, context.tools ?? [], signal);

        await emit({ type: 'tool_execution_end', toolCall, result });
        toolResults.push(result);
        context.messages.push(result);
        newMessages.push(result);
      }
    }

    await emit({
      type: 'turn_end',
      message: assistantMessage,
      toolResults,
    });

    const shouldStop = await config.shouldStopAfterTurn?.({
      message: assistantMessage,
      toolResults,
      context,
      newMessages,
    });
    if (shouldStop) {
      await emit({ type: 'agent_end', messages: newMessages });
      return;
    }

    const shouldContinue = assistantMessage.finishReason === 'tool_calls' && toolCalls.length > 0;
    if (!shouldContinue) {
      await emit({ type: 'agent_end', messages: newMessages });
      return;
    }

    await emit({ type: 'turn_start' });
  }
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
) {
  const convertToLlm = config.convertToLlm ?? defaultConvertToLlm;
  const llmMessages = await convertToLlm(context.messages);
  const llmContext: Context = {
    systemPrompt: context.systemPrompt,
    messages: [...llmMessages],
    tools: context.tools,
  };
  const stream = streamFn(config.model, llmContext, { signal });

  for await (const event of stream) {
    switch (event.type) {
      case 'start':
        await emit({ type: 'message_start' });
        break;
      case 'text.delta':
      case 'tool-call.delta':
      case 'tool-call.completed':
      case 'usage':
        await emit({ type: 'message_update', event });
        break;
      case 'done':
        await emit({
          type: 'message_end',
          message: event.response,
        });
        break;
      case 'error':
        // BufferedStream 会在迭代结束后让 result() 以同一个错误拒绝。
        break;
    }
  }

  return await stream.result();
}
