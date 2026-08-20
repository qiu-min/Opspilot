import type { AgentContext, AgentEventSink, AgentLoopConfig, StreamFn } from './types.js';

/**
 * 启动一次 Agent 运行并发出生命周期事件。
 * @param context 当前 Agent 的系统提示词、消息和工具上下文。
 * @param config 当前运行的模型和循环配置。
 * @param streamFn 创建模型事件流的函数。
 * @param emit 接收 AgentEvent 的事件接收器。
 * @param signal 用于取消模型请求的信号。
 */
export async function runAgentLoop(
  context: AgentContext,
  config: AgentLoopConfig,
  streamFn: StreamFn,
  emit: AgentEventSink,
  signal?: AbortSignal,
) {
  await emit({ type: 'agent_start' });

  await emit({ type: 'turn_start' });

  // 下一步就在这里调用 model-gateway
  const assistantMessage = await streamAssistantResponse(context, config, streamFn, emit, signal);

  await emit({ type: 'turn_end', message: assistantMessage, toolResults: [] });

  await emit({
    type: 'agent_end',
    messages: context.messages,
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
      messages: context.messages,
      tools: context.tools,
    },
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
