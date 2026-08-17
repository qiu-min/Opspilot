import {
  type Context,
  type ModelToolCall,
  ModelGatewayError,
  type Tool,
  validateModelToolCall,
} from '../contracts/index.js';

export type OpenAiCompletionTool = {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
    readonly strict: true;
  };
};
export function toOpenAiCompletionsTools(tools: readonly Tool[]): readonly OpenAiCompletionTool[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: true,
    },
  }));
}
export function toOpenAiCompletionsMessages(context: Context): readonly unknown[] {
  const messages = context.systemPrompt
    ? [
        { role: 'system' as const, content: [{ type: 'text' as const, text: context.systemPrompt }] },
        ...context.messages,
      ]
    : context.messages;
  return messages.map((message) => {
    const content = message.content.map((block) => block.text).join('\n');
    if (message.role === 'tool') return { role: 'tool', tool_call_id: message.callId, content };
    if (message.role === 'assistant')
      return {
        role: 'assistant',
        content: content || null,
        ...(message.toolCalls === undefined
          ? {}
          : {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.callId,
                type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.arguments) },
              })),
            }),
      };
    return { role: message.role, content };
  });
}
export function parseOpenAiCompletionsToolCall(
  tools: readonly Tool[] | undefined,
  value: unknown,
): ModelToolCall {
  const record = value as Record<string, unknown>;
  const functionValue = record?.function as Record<string, unknown> | undefined;
  if (
    typeof record?.id !== 'string' ||
    typeof functionValue?.name !== 'string' ||
    typeof functionValue?.arguments !== 'string'
  )
    throw new ModelGatewayError('INVALID_TOOL_CALL', 'Invalid OpenAI Chat Completions tool call.');
  let argumentsValue: unknown;
  try {
    argumentsValue = JSON.parse(functionValue.arguments);
  } catch (error) {
    throw new ModelGatewayError(
      'INVALID_TOOL_CALL',
      'OpenAI tool arguments must be valid JSON.',
      error,
    );
  }
  return validateModelToolCall(tools, {
    callId: record.id,
    name: functionValue.name,
    arguments: argumentsValue,
  });
}
