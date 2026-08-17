import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import {
  type Model,
  ModelGatewayError,
  modelApiSchema,
  openAiCompletionsCompatSchema,
  reasoningProtocolSchema,
  thinkingLevelMapSchema,
} from './contracts/index.js';
import type { ModelProviderDescriptor } from './model-gateway.js';

const id = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z][A-Za-z0-9_-]*$/);
const environmentVariable = z
  .string()
  .trim()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const url = z
  .string()
  .url()
  .refine((value) => /^https?:\/\//u.test(value), 'baseUrl must use HTTP(S).');
export const modelDefinitionConfigSchema = z
  .object({
    id: z.string().trim().min(1).max(200),
    name: z.string().trim().min(1).max(200).optional(),
    api: modelApiSchema,
    baseUrl: url.optional(),
    supportsTools: z.boolean().optional(),
    contextWindow: z.number().int().positive().optional(),
    reasoning: z.boolean().default(false),
    thinkingLevelMap: thinkingLevelMapSchema.optional(),
    reasoningProtocol: reasoningProtocolSchema.optional(),
    compat: openAiCompletionsCompatSchema.optional(),
  })
  .strict()
  .superRefine((model, context) => {
    if (model.reasoning && model.reasoningProtocol === undefined)
      context.addIssue({
        code: 'custom',
        path: ['reasoningProtocol'],
        message: 'reasoningProtocol is required when reasoning is enabled.',
      });
  });
export type ModelDefinitionConfig = z.infer<typeof modelDefinitionConfigSchema>;

export const modelProviderConfigSchema = z
  .object({
    id,
    name: z.string().trim().min(1).max(200).optional(),
    apiKey: z.string().trim().min(1).max(1_000).optional(),
    apiKeyEnv: environmentVariable.optional(),
    baseUrl: url,
    headers: z.record(z.string(), z.string()).optional(),
    timeoutMs: z.number().finite().positive().optional(),
    models: z.array(modelDefinitionConfigSchema).min(1).max(128),
  })
  .strict()
  .superRefine((provider, context) => {
    if ((provider.apiKey === undefined) === (provider.apiKeyEnv === undefined))
      context.addIssue({
        code: 'custom',
        path: ['apiKey'],
        message: 'Configure exactly one of apiKey or apiKeyEnv.',
      });
  });
export type ModelProviderConfig = z.infer<typeof modelProviderConfigSchema>;

export const modelGatewayConfigSchema = z
  .object({ providers: z.array(modelProviderConfigSchema).max(100) })
  .strict()
  .superRefine((value, context) => {
    const ids = value.providers.map((provider) => provider.id);
    if (new Set(ids).size !== ids.length)
      context.addIssue({
        code: 'custom',
        path: ['providers'],
        message: 'Provider IDs must be unique.',
      });
    for (const [index, provider] of value.providers.entries()) {
      const models = provider.models.map((model) => model.id);
      if (new Set(models).size !== models.length)
        context.addIssue({
          code: 'custom',
          path: ['providers', index, 'models'],
          message: 'Model IDs must be unique within a provider.',
        });
    }
  });
export type ModelGatewayConfig = z.infer<typeof modelGatewayConfigSchema>;

export interface ResolvedProvider extends ModelProviderDescriptor {
  readonly apiKey: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

export function resolveProviders(config: ModelGatewayConfig): readonly ResolvedProvider[] {
  return config.providers.map((provider) => {
    const apiKey = provider.apiKey ?? process.env[provider.apiKeyEnv!];
    if (!apiKey)
      throw new ModelGatewayError(
        'CONFIGURATION',
        `Environment variable ${provider.apiKeyEnv} is not set for provider ${provider.id}.`,
      );
    return {
      id: provider.id,
      name: provider.name ?? provider.id,
      baseUrl: provider.baseUrl,
      apiKey,
      ...(provider.headers === undefined ? {} : { headers: provider.headers }),
      ...(provider.timeoutMs === undefined ? {} : { timeoutMs: provider.timeoutMs }),
      models: provider.models.map((model): Model => ({
        provider: provider.id,
        id: model.id,
        name: model.name ?? model.id,
        api: model.api,
        baseUrl: model.baseUrl ?? provider.baseUrl,
        ...(model.supportsTools === undefined ? {} : { supportsTools: model.supportsTools }),
        ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
        reasoning: model.reasoning,
        ...(model.thinkingLevelMap === undefined
          ? {}
          : { thinkingLevelMap: model.thinkingLevelMap }),
        ...(model.reasoningProtocol === undefined
          ? {}
          : { reasoningProtocol: model.reasoningProtocol }),
        ...(model.compat === undefined ? {} : { compat: model.compat }),
      })),
    };
  });
}
export async function loadModelGatewayConfig(
  path = 'config/model-providers.json',
): Promise<ModelGatewayConfig> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new ModelGatewayError(
      'CONFIGURATION',
      `Unable to read model gateway configuration: ${path}`,
      error,
    );
  }
  const parsed = modelGatewayConfigSchema.safeParse(raw);
  if (!parsed.success)
    throw new ModelGatewayError(
      'CONFIGURATION',
      'Model gateway configuration is invalid.',
      parsed.error,
    );
  return parsed.data;
}
