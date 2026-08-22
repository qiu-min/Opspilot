import OpenAI, { APIConnectionTimeoutError, AuthenticationError, RateLimitError } from 'openai';
import {
  createModelEventStream,
  type Context,
  type FinishReason,
  type Model,
  type ModelEventStream,
  ModelGatewayError,
  type TextContent,
  type ThinkingContent,
  type ThinkingSignature,
  toModelGatewayError,
  type Usage,
  type AssistantMessage,
} from '../contracts/index.js';
import type { ResolvedProvider } from '../provider-config.js';
import type { ResolvedOptions } from '../thinking.js';
import {
  parseOpenAiCompletionsToolCall,
  toOpenAiCompletionsMessages,
  toOpenAiCompletionsTools,
} from './openai-completions-tools.js';
import { parseStreamingJson } from '../utils/parse-streaming-json.js';
import type { ModelAdapter } from './model-adapter.js';

export interface OpenAiCompletionsRequest {
  readonly model: string;
  readonly messages: readonly unknown[];
  readonly tools?: readonly unknown[];
  readonly tool_choice?: 'auto';
  readonly stream: true;
  readonly stream_options: { readonly include_usage: true };
  readonly response_format?: unknown;
  readonly temperature?: number;
  readonly max_tokens?: number;
  readonly max_completion_tokens?: number;
  readonly reasoning_effort?: string;
  readonly reasoning?: { readonly effort: string };
  readonly thinking?: { readonly type: 'enabled' };
}

export interface OpenAiCompletionsClient {
  readonly chat: {
    readonly completions: {
      create(
        request: OpenAiCompletionsRequest,
        options?: { signal?: AbortSignal },
      ): Promise<AsyncIterable<unknown>>;
    };
  };
}

export type OpenAiCompletionsClientFactory = (
  provider: ResolvedProvider,
  baseUrl: string,
) => OpenAiCompletionsClient;
const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
function defaultClient(provider: ResolvedProvider, baseUrl: string): OpenAiCompletionsClient {
  const client = new OpenAI({
    apiKey: provider.apiKey,
    baseURL: baseUrl,
    timeout: provider.timeoutMs,
    defaultHeaders: provider.headers,
  });
  return {
    chat: {
      completions: {
        async create(request, options) {
          return client.chat.completions.create(request as never, {
            signal: options?.signal,
          }) as unknown as Promise<AsyncIterable<unknown>>;
        },
      },
    },
  };
}
function providerError(error: unknown): ModelGatewayError {
  if (error instanceof ModelGatewayError) return error;
  const record = asRecord(error);
  if (error instanceof AuthenticationError || record?.status === 401 || record?.status === 403)
    return new ModelGatewayError('AUTHENTICATION', 'Model provider authentication failed.');
  if (error instanceof RateLimitError || record?.status === 429)
    return new ModelGatewayError('RATE_LIMITED', 'Model provider rate limit exceeded.');
  if (error instanceof APIConnectionTimeoutError || record?.name === 'AbortError')
    return new ModelGatewayError('TIMEOUT', 'Model provider request timed out.');
  return toModelGatewayError(error);
}
function usage(value: unknown): Usage | undefined {
  const item = asRecord(value);
  if (
    !item ||
    typeof item.prompt_tokens !== 'number' ||
    typeof item.completion_tokens !== 'number' ||
    typeof item.total_tokens !== 'number'
  )
    return undefined;
  return {
    inputTokens: item.prompt_tokens,
    outputTokens: item.completion_tokens,
    totalTokens: item.total_tokens,
  };
}
function finish(value: string): Exclude<FinishReason, 'pending'> {
  switch (value) {
    case 'stop':
      return 'stop';

    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';

    case 'length':
      return 'length';

    case 'content_filter':
      return 'refusal';

    default:
      throw new ModelGatewayError(
        'INVALID_RESPONSE',
        `Unknown provider finish reason: ${value}`,
      );
  }
}

function reasoningRequest(options: ResolvedOptions): Partial<OpenAiCompletionsRequest> {
  const reasoning = options.resolvedReasoning;
  if (!reasoning) return {};
  switch (reasoning.protocol) {
    case 'openai-reasoning-effort':
      return { reasoning_effort: reasoning.providerValue };
    case 'openai-reasoning-object':
      return { reasoning: { effort: reasoning.providerValue } };
    case 'deepseek-thinking':
      return {
        thinking: { type: 'enabled' },
        reasoning_effort: reasoning.providerValue,
      };
  }
}

export class OpenAiCompletionsModelAdapter implements ModelAdapter {
  readonly api = 'openai-completions';
  constructor(private readonly clientFactory: OpenAiCompletionsClientFactory = defaultClient) {}
  stream(
    model: Model,
    context: Context,
    options: ResolvedOptions,
    provider: ResolvedProvider,
  ): ModelEventStream {

    return createModelEventStream(async (controller) => {
      type StreamingBlock = TextContent | ThinkingContent;
      const blocks: StreamingBlock[] = [];
      let textBlock: TextContent | undefined;
      let thinkingBlock: ThinkingContent | undefined;
      let responseId: string | undefined;
      let finalReason: Exclude<FinishReason, 'pending'> | undefined;
      let rawFinishReason: string | undefined;
      let finalUsage: Usage | undefined;
      const calls = new Map<number, { id?: string; name?: string; arguments: string }>();
      const completedCalls = new Map<number, NonNullable<AssistantMessage['toolCalls']>[number]>();

      /** 创建当前 Provider 响应的独立半成品快照。
       * @returns 包含累计内容、工具调用、用量和响应 ID 的 pending assistant 消息。
       */
      const createPartial = (): AssistantMessage => {
        const content = blocks.map((block) =>
          block.type === 'text' ? { ...block } : { ...block, source: { ...block.source } },
        );
        const toolCalls = [...calls.entries()]
          .sort(([left], [right]) => left - right)
          .filter(([, call]) => call.id !== undefined && call.name !== undefined)
          .map(([index, call]) =>
            completedCalls.get(index) ?? {
              callId: call.id as string,
              name: call.name as string,
              arguments: parseStreamingJson(call.arguments),
            },
          );
        return {
          role: 'assistant',
          api: model.api,
          provider: model.provider,
          model: model.id,
          content,
          ...(toolCalls.length === 0 ? {} : { toolCalls }),
          finishReason: 'pending',
          ...(finalUsage === undefined ? {} : { usage: { ...finalUsage } }),
          ...(responseId === undefined ? {} : { responseId }),
          ...(options.resolvedReasoning === undefined
            ? {}
            : {
                reasoning: {
                  requested: options.resolvedReasoning.requested,
                  selected: options.resolvedReasoning.selected,
                },
              }),
        };
      };

      /** 确保文本内容块存在并返回其当前值。
       * @returns 当前累计文本内容块。
       */
      const ensureTextBlock = (): TextContent => {
        if (!textBlock) {
          textBlock = { type: 'text', text: '' };
          blocks.push(textBlock);
        }
        return textBlock;
      };

      /** 确保推理内容块存在并返回其当前值。
       * @param thinkingSignature 当前 Provider 使用的推理字段标识。
       * @returns 当前累计推理内容块。
       */
      const ensureThinkingBlock = (thinkingSignature: ThinkingSignature): ThinkingContent => {
        if (!thinkingBlock) {
          thinkingBlock = {
            type: 'thinking',
            thinking: '',
            thinkingSignature,
            source: { api: model.api, provider: model.provider, model: model.id },
          };
          blocks.push(thinkingBlock);
        }
        return thinkingBlock;
      };

      controller.emit({ type: 'start', model, partial: createPartial() });
      try {
        const client = this.clientFactory(provider, model.baseUrl);
        const stream = await client.chat.completions.create(
          {
            model: model.id,
            messages: toOpenAiCompletionsMessages(context, model),
            ...(context.tools && context.tools.length > 0
              ? { tools: toOpenAiCompletionsTools(context.tools), tool_choice: 'auto' as const }
              : {}),
            stream: true,
            stream_options: { include_usage: true },
            ...(options.responseFormat === undefined
              ? {}
              : {
                  response_format: {
                    type: 'json_schema',
                    json_schema: {
                      name: options.responseFormat.name,
                      schema: options.responseFormat.schema,
                      strict: options.responseFormat.strict,
                    },
                  },
                }),
            ...(options.temperature === undefined
              ? {}
              : model.compat?.supportsTemperature === false
                ? (() => {
                    throw new ModelGatewayError(
                      'UNSUPPORTED_CAPABILITY',
                      `Model ${model.provider}/${model.id} does not support temperature.`,
                    );
                  })()
                : { temperature: options.temperature }),
            ...(options.maxTokens === undefined
              ? {}
              : model.compat?.maxTokensField === 'max_completion_tokens'
                ? { max_completion_tokens: options.maxTokens }
                : { max_tokens: options.maxTokens }),
            ...reasoningRequest(options),
          },
          { signal: options.signal },
        );
        for await (const chunk of stream) {
          const record = asRecord(chunk);
          if (typeof record?.id === 'string') responseId = record.id;
          const chunkUsage = usage(record?.usage);
          if (chunkUsage) {
            finalUsage = chunkUsage;
            controller.emit({ type: 'usage', usage: chunkUsage, partial: createPartial() });
          }
          const choice = Array.isArray(record?.choices) ? asRecord(record.choices[0]) : undefined;
          if (!choice) continue;
          if (typeof choice.finish_reason === 'string') {
            rawFinishReason = choice.finish_reason;
            finalReason = finish(choice.finish_reason);
          }
          const delta = asRecord(choice.delta);
          if (typeof delta?.content === "string" && delta.content.length > 0) { 
            const previous = ensureTextBlock();
            textBlock = { ...previous, text: previous.text + delta.content };
            blocks[blocks.indexOf(previous)] = textBlock;
            controller.emit({
              type: 'text.delta',
              contentIndex: blocks.indexOf(textBlock),
              delta: delta.content,
              partial: createPartial(),
            });
          }
          for (const field of ['reasoning_content', 'reasoning', 'reasoning_text']) {
            if (typeof delta?.[field] === 'string' && delta[field].length > 0) {
              const signature = field as ThinkingSignature;
              if (thinkingBlock && thinkingBlock.thinkingSignature !== signature) break;
              const previous = ensureThinkingBlock(signature);
              thinkingBlock = { ...previous, thinking: previous.thinking + delta[field] };
              blocks[blocks.indexOf(previous)] = thinkingBlock;
              controller.emit({
                type: 'thinking.delta',
                contentIndex: blocks.indexOf(thinkingBlock),
                delta: delta[field],
                partial: createPartial(),
              });
              break;
            }
          }
          if (Array.isArray(delta?.tool_calls))
            for (const rawCall of delta.tool_calls) {
              const part = asRecord(rawCall);
              if (!part || typeof part.index !== 'number') continue;
              const item = calls.get(part.index) ?? { arguments: '' };
              if (typeof part.id === 'string') item.id = part.id;
              const functionPart = asRecord(part.function);
              if (typeof functionPart?.name === 'string') item.name = functionPart.name;
              if (typeof functionPart?.arguments === 'string') {
                item.arguments += functionPart.arguments;
                calls.set(part.index, item);
                if (item.id)
                  controller.emit({
                    type: 'tool-call.delta',
                    contentIndex: part.index,
                    callId: item.id,
                    delta: functionPart.arguments,
                    partial: createPartial(),
                  });
              } else {
                calls.set(part.index, item);
              }
            }
        }
        if (finalReason === undefined)
          throw new ModelGatewayError(
            'INVALID_RESPONSE',
            'Model provider stream ended without a finish reason.',
          );
        const toolCalls = [...calls.entries()].map(([index, call]) => {
          if (!call.id || !call.name)
            throw new ModelGatewayError(
              'INVALID_TOOL_CALL',
              'OpenAI tool call stream ended before name or ID.',
            );
          const toolCall = parseOpenAiCompletionsToolCall(context.tools, {
            id: call.id,
            function: { name: call.name, arguments: call.arguments },
          });
          completedCalls.set(index, toolCall);
          controller.emit({
            type: 'tool-call.completed',
            contentIndex: index,
            toolCall,
            partial: createPartial(),
          });
          return toolCall;
        });
        if (blocks.length === 0 && toolCalls.length === 0)
          throw new ModelGatewayError(
            'INVALID_RESPONSE',
            'Model provider returned no text or tool call.',
          );
        
        const response: AssistantMessage = {
          role: 'assistant',
          api: model.api,
          provider: model.provider,
          model: model.id,
          content: blocks,
          toolCalls,
          finishReason: toolCalls.length > 0 ? 'tool_calls' : finalReason,
          ...(rawFinishReason === undefined ? {} : { rawFinishReason }),
          ...(finalUsage === undefined ? {} : { usage: finalUsage }),
          ...(responseId === undefined ? {} : { responseId }),
          ...(options.resolvedReasoning === undefined
            ? {}
            : {
                reasoning: {
                  requested: options.resolvedReasoning.requested,
                  selected: options.resolvedReasoning.selected,
                },
              }),
        };
        controller.complete(response);
      } catch (error) {
        controller.fail(providerError(error));
      }
    });
  }
}
