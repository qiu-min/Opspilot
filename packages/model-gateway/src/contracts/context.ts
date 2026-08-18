import { z } from 'zod';
import { ModelGatewayError } from './errors.js';
import { finishReasonSchema, usageSchema, type FinishReason, type ReasoningDecision, type Usage } from './response.js';

const text = (max: number) => z.string().trim().min(1).max(max);
const callIdSchema = text(200);

export const toolNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_-]*$/);

export const jsonObjectSchema = z.record(z.string(), z.unknown());
export type JsonObject = z.infer<typeof jsonObjectSchema>;

export interface Tool<TParameters extends JsonObject = JsonObject> {
  readonly name: string;
  readonly description: string;
  readonly parameters: TParameters;
}

export const toolSchema = z
  .object({
    name: toolNameSchema,
    description: text(2_000),
    parameters: jsonObjectSchema.superRefine((value, context) => {
      if (value.type !== 'object')
        context.addIssue({
          code: 'custom',
          path: ['type'],
          message: 'Tool parameters.type must be "object".',
        });
      if (
        !Object.hasOwn(value, 'properties') ||
        !jsonObjectSchema.safeParse(value.properties).success
      )
        context.addIssue({
          code: 'custom',
          path: ['properties'],
          message: 'Tool parameters.properties must be an object.',
        });
    }),
  })
  .strict();

export interface TextContent {
  readonly type: 'text';
  readonly text: string;
}

export const textContentSchema = z
  .object({ type: z.literal('text'), text: z.string().max(100_000) })
  .strict();

export const thinkingSignatureSchema = z.enum(['reasoning_content', 'reasoning', 'reasoning_text']);
export type ThinkingSignature = z.infer<typeof thinkingSignatureSchema>;

export interface ThinkingSource {
  readonly api: string;
  readonly provider: string;
  readonly model: string;
}

export const thinkingSourceSchema = z
  .object({
    api: text(100),
    provider: text(100),
    model: text(200),
  })
  .strict();

/** 表示 Provider 返回的私有推理内容，仅用于后续请求保持上下文连续性。 */
export interface ThinkingContent {
  readonly type: 'thinking';
  readonly thinking: string;
  readonly thinkingSignature: ThinkingSignature;
  readonly source: ThinkingSource;
}

export const thinkingContentSchema = z
  .object({
    type: z.literal('thinking'),
    thinking: z.string().max(1_000_000),
    thinkingSignature: thinkingSignatureSchema,
    source: thinkingSourceSchema,
  })
  .strict();

export type AssistantContent = TextContent | ThinkingContent;

export interface ModelToolCall<TArguments extends JsonObject = JsonObject> {
  readonly callId: string;
  readonly name: string;
  readonly arguments: TArguments;
}

export const modelToolCallSchema = z
  .object({ callId: callIdSchema, name: toolNameSchema, arguments: jsonObjectSchema })
  .strict();

export interface UserMessage {
  readonly role: 'user';
  readonly content: readonly TextContent[];
}

export interface AssistantMessage {
  readonly role: 'assistant';
  readonly api: string;
  readonly provider: string;
  readonly model: string;
  readonly content: readonly AssistantContent[];
  readonly toolCalls?: readonly ModelToolCall[];
  readonly finishReason: FinishReason;
  readonly rawFinishReason?: string;
  readonly usage?: Usage;
  readonly responseId?: string;
  readonly reasoning?: ReasoningDecision;
}

export interface ToolResultMessage {
  readonly role: 'tool';
  readonly callId: string;
  readonly name: string;
  readonly content: readonly TextContent[];
  readonly isError: boolean;
}

export type Message =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage

export const messageSchema = z.discriminatedUnion('role', [
  z
    .object({ role: z.literal('user'), content: z.array(textContentSchema).min(1).max(100) })
    .strict(),
  z
    .object({
      role: z.literal('assistant'),
      api: z.string().max(100),
      provider: z.string().max(100),
      model: z.string().max(200),
      content: z.array(z.union([textContentSchema, thinkingContentSchema])).max(100),
      toolCalls: z.array(modelToolCallSchema).max(128).optional(),
      finishReason: finishReasonSchema,
      rawFinishReason: z.string().max(200).optional(),
      usage: usageSchema.optional(),
      responseId: z.string().trim().min(1).max(200).optional(),
      reasoning: z
        .object({
          requested: z.enum(['minimal', 'low', 'medium', 'high']),
          selected: z.enum(['off', 'minimal', 'low', 'medium', 'high']),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      role: z.literal('tool'),
      callId: callIdSchema,
      name: toolNameSchema,
      content: z.array(textContentSchema).min(1).max(100),
      isError: z.boolean(),
    })
    .strict(),
]);

export interface Context {
  readonly systemPrompt?: string;
  readonly messages: readonly Message[];
  readonly tools?: readonly Tool[];
}

export const contextSchema = z
  .object({
    systemPrompt: z.string().trim().min(1).max(100_000).optional(),
    messages: z.array(messageSchema).min(1).max(1_000),
    tools: z.array(toolSchema).max(128).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const names = (value.tools ?? []).map((tool) => tool.name);
    if (new Set(names).size !== names.length)
      context.addIssue({ code: 'custom', path: ['tools'], message: 'Tool names must be unique.' });
  });

export function validateContext(value: unknown): Context {
  const parsed = contextSchema.safeParse(value);
  if (!parsed.success)
    throw new ModelGatewayError('INVALID_INPUT', 'Invalid model context.', parsed.error);
  return parsed.data;
}

export function validateModelToolCall(
  tools: readonly Tool[] | undefined,
  call: unknown,
): ModelToolCall {
  const parsed = modelToolCallSchema.safeParse(call);
  if (!parsed.success)
    throw new ModelGatewayError('INVALID_TOOL_CALL', 'Invalid model tool call.', parsed.error);
  if (!(tools ?? []).some((tool) => tool.name === parsed.data.name))
    throw new ModelGatewayError(
      'INVALID_TOOL_CALL',
      'Model called a tool that was not declared in the context.',
    );
  return parsed.data;
}
