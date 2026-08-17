import {
  type Context,
  type OpenAiCompletionsCompat,
  type ModelToolCall,
  ModelGatewayError,
  type Tool,
  type TextContent,
  type ThinkingContent,
  validateModelToolCall,
} from '../contracts/index.js';

function textFromContent(blocks: readonly (TextContent | ThinkingContent)[]): string {
  return blocks
    .filter((block): block is TextContent => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

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
/** 将统一上下文转换为 OpenAI Chat Completions 消息，保留 Provider 要求的推理字段。 */
export function toOpenAiCompletionsMessages(
  context: Context,
  compat: OpenAiCompletionsCompat | undefined,
): readonly unknown[] {
  const messages = context.systemPrompt
    ? [
        {
          role: 'system' as const,
          content: [{ type: 'text' as const, text: context.systemPrompt }],
        },
        ...context.messages,
      ]
    : context.messages;
  return messages.map((message) => {
    const content = textFromContent(message.content);
    if (message.role === 'tool') return { role: 'tool', tool_call_id: message.callId, content };
    if (message.role === 'assistant') {
      const thinkingBlocks = message.content.filter(
        (block): block is Extract<(typeof message.content)[number], { type: 'thinking' }> =>
          block.type === 'thinking' && block.thinking.length > 0,
      );
      const reasoning = thinkingBlocks[0];
      const toolCalls = message.toolCalls;
      return {
        role: 'assistant',
        content: content || null,
        ...(reasoning?.thinkingSignature === undefined
          ? compat?.requiresReasoningContentOnAssistantMessages && toolCalls && toolCalls.length > 0
            ? { reasoning_content: '' }
            : {}
          : {
              [reasoning.thinkingSignature]: thinkingBlocks
                .map((block) => block.thinking)
                .join('\n'),
            }),
        ...(toolCalls === undefined
          ? {}
          : {
              tool_calls: toolCalls.map((call) => ({
                id: call.callId,
                type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.arguments) },
              })),
            }),
      };
    }
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
