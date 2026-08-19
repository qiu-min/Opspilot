import type {
  AgentContext,
  AgentEventSink,
  AgentLoopConfig,
  StreamFn,
} from './types.js';

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
    // 这里把 ModelStreamEvent 转成 AgentEvent
  }

  return await stream.result();
}