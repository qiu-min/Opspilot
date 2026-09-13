import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  AuthenticationError,
  RateLimitError,
} from 'openai';
import {
  createModelEventStream,
  type Context,
  type FinishReason,
  type Model,
  type ModelEventStream,
  type TextContent,
  type ThinkingContent,
  type ThinkingSignature,
  type Usage,
  type AssistantMessage,
  type ModelErrorInfo,
  type ModelErrorKind,
  MODEL_ERROR_METADATA,
} from '../contracts/index.js';
import type { ResolvedProvider } from '../provider-config.js';
import type { ResolvedOptions } from '../thinking.js';
import {
  parseOpenAiCompletionsToolCall,
  toOpenAiCompletionsMessages,
  toOpenAiCompletionsTools,
} from './openai-completions-tools.js';
import { resolveOpenAiCompletionsCompat } from './openai-completions-compat.js';
import { parseStreamingJson } from '../utils/parse-streaming-json.js';
import type { ModelAdapter } from './model-adapter.js';
import { isContextOverflowErrorMessage } from '../compat/context-overflow-patterns.js';

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
  readonly thinking?: { readonly type: 'enabled' | 'disabled' };
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
/** Maps an adapter-internal or Provider error into a safe public diagnostic. */
export function classifyProviderError(error: unknown): ModelErrorInfo {
  const record = asRecord(error);
  const statusCode = getStatusCode(record?.status ?? record?.statusCode);
  const providerCode = getProviderCode(record?.code);
  const errorMessage = getErrorMessage(error);

  if (error instanceof ProviderProtocolError)
    return createModelError('protocol_error', error.message, statusCode, providerCode);
  if (error instanceof AuthenticationError || statusCode === 401 || statusCode === 403)
    return createModelError(
      'authentication',
      'Model provider authentication failed.',
      statusCode,
      providerCode,
    );
  if (error instanceof RateLimitError || statusCode === 429)
    return createModelError(
      'rate_limit',
      'Model provider rate limit exceeded.',
      statusCode,
      providerCode,
    );
  if (
    isStrongTimeoutError(error, record) ||
    (statusCode === undefined && isTimeoutMessage(errorMessage))
  )
    return createModelError(
      'timeout',
      'Model provider request timed out.',
      statusCode,
      providerCode,
    );
  if (isNetworkError(error, record))
    return createModelError(
      'network',
      'Model provider network request failed.',
      statusCode,
      providerCode,
    );
  if (statusCode !== undefined && statusCode >= 500)
    return createModelError(
      'server_error',
      'Model provider returned a server error.',
      statusCode,
      providerCode,
    );
  if (isContextOverflowErrorMessage(errorMessage))
    return createModelError(
      'context_overflow',
      'Model provider context window exceeded.',
      statusCode,
      providerCode,
    );
  if (statusCode !== undefined && statusCode >= 400 && statusCode < 500)
    return createModelError(
      'invalid_request',
      'Model provider rejected the request.',
      statusCode,
      providerCode,
    );

  return createModelError(
    'unknown',
    'Model provider request failed.',
    statusCode,
    providerCode,
  );
}

/** Internal marker for malformed Provider protocol data found by this Adapter. */
class ProviderProtocolError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ProviderProtocolError';
  }
}

function createModelError(
  kind: ModelErrorKind,
  message: string,
  statusCode: number | undefined,
  providerCode: string | undefined,
): ModelErrorInfo {
  const metadata = MODEL_ERROR_METADATA[kind];
  return {
    kind,
    code: metadata.code,
    message: message || 'Model provider request failed.',
    retryable: metadata.retryable,
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(providerCode === undefined ? {} : { providerCode }),
  };
}

function getErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return '';
  const message = error.message.trim();
  if (message.length === 0) return '';
  // Provider SDK metadata is intentionally not copied; cap the human-readable fallback as well.
  return message.slice(0, 100_000);
}

function getStatusCode(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;
}

function getProviderCode(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const code = value.trim();
  return /^[A-Za-z0-9_.:-]{1,200}$/.test(code) ? code : undefined;
}

function isStrongTimeoutError(
  error: unknown,
  record: Record<string, unknown> | undefined,
): boolean {
  if (error instanceof APIConnectionTimeoutError || record?.name === 'APIConnectionTimeoutError')
    return true;
  if (record?.code === 'ETIMEDOUT' || record?.code === 'UND_ERR_CONNECT_TIMEOUT') return true;
  return typeof record?.name === 'string' && /timeout/i.test(record.name);
}

function isTimeoutMessage(message: string): boolean {
  return /\btimeout\b/i.test(message);
}

function isNetworkError(error: unknown, record: Record<string, unknown> | undefined): boolean {
  if (error instanceof APIConnectionError || record?.name === 'APIConnectionError') return true;
  return (
    record?.code === 'ECONNRESET' ||
    record?.code === 'ECONNREFUSED' ||
    record?.code === 'ENOTFOUND' ||
    record?.code === 'EAI_AGAIN' ||
    record?.code === 'ECONNABORTED' ||
    record?.code === 'EPIPE' ||
    record?.code === 'UND_ERR_CONNECT_TIMEOUT'
  );
}
function isAbortError(error: unknown): boolean {
  const record = asRecord(error);
  return (
    record?.name === 'AbortError' ||
    record?.name === 'APIUserAbortError' ||
    record?.code === 'ABORT_ERR'
  );
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
function finish(value: string): Exclude<FinishReason, 'pending' | 'error' | 'aborted'> {
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
      throw new ProviderProtocolError(`Unknown provider finish reason: ${value}`);
  }
}

function reasoningRequest(
  model: Model,
  options: ResolvedOptions,
): Partial<OpenAiCompletionsRequest> {
  const reasoning = options.resolvedReasoning;
  if (!reasoning) {
    if (
      model.reasoningProtocol === 'deepseek-thinking' &&
      typeof model.thinkingLevelMap?.off === 'string'
    )
      return { thinking: { type: 'disabled' } };
    return {};
  }
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
    const compat = resolveOpenAiCompletionsCompat(model);
    if (options.temperature !== undefined && !compat.supportsTemperature)
      throw new Error(`Model ${model.provider}/${model.id} does not support temperature.`);

    return createModelEventStream(async (controller) => {
      type StreamingBlock = TextContent | ThinkingContent;
      const blocks: StreamingBlock[] = [];
      let textBlock: TextContent | undefined;
      let thinkingBlock: ThinkingContent | undefined;
      let responseId: string | undefined;
      let finalReason: Exclude<FinishReason, 'pending' | 'error' | 'aborted'> | undefined;
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

      /** 将当前 Adapter 状态封装成模型失败终止消息。
       * @param error Provider 或响应解析阶段捕获的异常。
       * @param aborted 是否由调用方 AbortSignal 主动终止。
       * @returns 保留已有输出并带有终止原因的 assistant 消息。
       */
      const createFailureMessage = (error: unknown, aborted: boolean): AssistantMessage => {
        if (aborted) {
          return {
            ...createPartial(),
            finishReason: 'aborted',
            errorMessage: 'Request aborted.',
          };
        }
        const modelError = classifyProviderError(error);
        return {
          ...createPartial(),
          finishReason: 'error',
          errorMessage: modelError.message,
          modelError,
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
              ? {
                  tools: toOpenAiCompletionsTools(context.tools),
                  ...(compat.supportsToolChoice ? { tool_choice: 'auto' as const } : {}),
                }
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
              : { temperature: options.temperature }),
            ...(options.maxTokens === undefined
              ? {}
              : compat.maxTokensField === 'max_completion_tokens'
                ? { max_completion_tokens: options.maxTokens }
                : { max_tokens: options.maxTokens }),
            ...reasoningRequest(model, options),
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
          if (typeof delta?.content === 'string' && delta.content.length > 0) {
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
          throw new ProviderProtocolError('Model provider stream ended without a finish reason.');
        const toolCalls = [...calls.entries()].map(([index, call]) => {
          if (!call.id || !call.name)
            throw new ProviderProtocolError('OpenAI tool call stream ended before name or ID.');
          let toolCall: NonNullable<AssistantMessage['toolCalls']>[number];
          try {
            toolCall = parseOpenAiCompletionsToolCall(context.tools, {
              id: call.id,
              function: { name: call.name, arguments: call.arguments },
            });
          } catch (error: unknown) {
            throw new ProviderProtocolError(
              error instanceof Error ? error.message : 'OpenAI tool call response was invalid.',
            );
          }
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
          throw new ProviderProtocolError('Model provider returned no text or tool call.');

        const response: AssistantMessage = {
          role: 'assistant',
          api: model.api,
          provider: model.provider,
          model: model.id,
          content: blocks,
          ...(toolCalls.length === 0 ? {} : { toolCalls }),
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
        const aborted = options.signal?.aborted === true || isAbortError(error);
        controller.error(createFailureMessage(error, aborted));
      }
    });
  }
}
