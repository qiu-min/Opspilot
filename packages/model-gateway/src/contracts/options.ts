import { z } from 'zod';
import { jsonObjectSchema, toolNameSchema } from './context.js';
import { ModelGatewayError } from './errors.js';
import { thinkingLevelSchema, type ThinkingLevel } from './model.js';

export interface ResponseFormat {
  readonly name: string;
  readonly schema: Record<string, unknown>;
  readonly strict: boolean;
}

export const responseFormatSchema = z
  .object({ name: toolNameSchema, schema: jsonObjectSchema, strict: z.boolean().default(true) })
  .strict();

export interface Options {
  readonly reasoning?: ThinkingLevel;
  readonly responseFormat?: ResponseFormat;
  readonly signal?: AbortSignal;
  readonly temperature?: number;
  readonly maxTokens?: number;
}

export const optionsSchema = z
  .object({
    reasoning: thinkingLevelSchema.optional(),
    responseFormat: responseFormatSchema.optional(),
    temperature: z.number().finite().min(0).max(2).optional(),
    maxTokens: z.number().int().positive().optional(),
  })
  .strict();

export function validateOptions(options: Options | undefined): Options {
  const { signal, ...plain } = options ?? {};
  const parsed = optionsSchema.safeParse(plain);
  if (!parsed.success) throw new ModelGatewayError('INVALID_INPUT', 'Invalid model options.', parsed.error);
  return signal === undefined ? parsed.data : { ...parsed.data, signal };
}
