import type {
  AgentContext,
  AgentEventSink,
  AgentLoopConfig,
  AgentMessage,
  StreamFn,
} from './types.js';
import type { Context, Message } from '@opspilot/model-gateway';

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

  const assistantMessage = await streamAssistantResponse(
    currentContext,
    config,
    streamFn,
    emit,
    signal,
  );
  currentContext.messages.push(assistantMessage);
  newMessages.push(assistantMessage);

  await emit({ type: 'turn_end', message: assistantMessage, toolResults: [] });

  await emit({
    type: 'agent_end',
    messages: newMessages,
  });

  return newMessages;
}

/**
 * 判断 Agent 消息是否属于 model-gateway 的标准消息。
 * @param message 待判断的 Agent 消息。
 */
function isModelMessage(message: AgentMessage): message is Message {
  if (typeof message !== 'object' || message === null || !('role' in message)) return false;
  return message.role === 'user' || message.role === 'assistant' || message.role === 'tool';
}

/**
 * 将 Agent 消息转换为模型网关可消费的标准消息。
 * @param messages 当前 Agent 运行上下文中的消息。
 */
function toModelMessages(messages: readonly AgentMessage[]): Message[] {
  return messages.map((message) => {
    if (!isModelMessage(message))
      throw new Error('Custom AgentMessage cannot be sent to model-gateway yet.');
    return message;
  });
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
  const stream = streamFn(
    config.model,
    {
      systemPrompt: context.systemPrompt,
      messages: toModelMessages(context.messages),
      tools: context.tools,
    } satisfies Context,
    { signal },
  );

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
