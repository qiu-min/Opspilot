import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadModelGatewayConfig,
  modelGatewayConfigSchema,
  resolveProviders,
  type ModelGatewayConfig,
} from '../src/index.js';

const config = {
  providers: [
    {
      id: 'moonshot',
      name: 'Moonshot',
      apiKey: 'key',
      baseUrl: 'https://moonshot.example/v1',
      models: [
        { id: 'kimi', api: 'openai-completions', supportsTools: true, reasoning: false },
        {
          id: 'override',
          api: 'openai-completions',
          baseUrl: 'https://other.example/v1',
          reasoning: false,
        },
      ],
    },
    {
      id: 'deepseek',
      name: 'DeepSeek',
      apiKey: 'deepseek-key',
      baseUrl: 'https://api.deepseek.com',
      models: [
        {
          id: 'deepseek-v4-flash',
          name: 'DeepSeek V4 Flash',
          api: 'openai-completions',
          supportsTools: true,
          contextWindow: 1_000_000,
          reasoning: true,
          reasoningProtocol: 'deepseek-thinking',
          thinkingLevelMap: {
            off: 'disabled',
            minimal: 'low',
            low: 'low',
            medium: 'high',
            high: 'max',
          },
          compat: {
            maxTokensField: 'max_tokens',
            supportsToolChoice: false,
            requiresReasoningContentOnAssistantMessages: true,
            requiresAssistantContentForToolCalls: true,
          },
        },
      ],
    },
  ],
} satisfies ModelGatewayConfig;
describe('provider configuration', () => {
  it('validates configuration and resolves inherited model URLs', () => {
    expect(modelGatewayConfigSchema.safeParse(config).success).toBe(true);
    expect(modelGatewayConfigSchema.safeParse({ providers: [] }).success).toBe(true);
    const providers = resolveProviders(config);
    expect(providers[0]?.models).toMatchObject([
      { provider: 'moonshot', baseUrl: 'https://moonshot.example/v1' },
      { baseUrl: 'https://other.example/v1' },
    ]);
  });
  it('validates and resolves the DeepSeek V4 Flash configuration', () => {
    expect(modelGatewayConfigSchema.safeParse(config).success).toBe(true);
    const deepSeek = resolveProviders(config)[1];
    const model = deepSeek?.models[0];

    expect(deepSeek).toMatchObject({
      id: 'deepseek',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com',
    });
    expect(model).toMatchObject({
      provider: 'deepseek',
      id: 'deepseek-v4-flash',
      api: 'openai-completions',
      contextWindow: 1_000_000,
      reasoningProtocol: 'deepseek-thinking',
      thinkingLevelMap: {
        off: 'disabled',
        minimal: 'low',
        low: 'low',
        medium: 'high',
        high: 'max',
      },
      compat: {
        maxTokensField: 'max_tokens',
        supportsToolChoice: false,
        requiresReasoningContentOnAssistantMessages: true,
        requiresAssistantContentForToolCalls: true,
      },
    });
  });
  it('rejects duplicate IDs and invalid configuration files', async () => {
    expect(
      modelGatewayConfigSchema.safeParse({ providers: [config.providers[0], config.providers[0]] })
        .success,
    ).toBe(false);
    const dir = await mkdtemp(join(tmpdir(), 'opspilot-'));
    const path = join(dir, 'providers.json');
    await writeFile(path, '{');
    await expect(loadModelGatewayConfig(path)).rejects.toThrow(
      `Unable to read model gateway configuration: ${path}`,
    );
  });
  it('requires exactly one credential source', () => {
    expect(
      modelGatewayConfigSchema.safeParse({
        providers: [{ ...config.providers[0], apiKey: undefined, apiKeyEnv: undefined }],
      }).success,
    ).toBe(false);
    expect(
      modelGatewayConfigSchema.safeParse({
        providers: [{ ...config.providers[0], apiKeyEnv: 'MOONSHOT_API_KEY' }],
      }).success,
    ).toBe(false);
    expect(
      modelGatewayConfigSchema.safeParse({
        providers: [{ ...config.providers[0], apiKey: undefined, apiKeyEnv: 'MOONSHOT_API_KEY' }],
      }).success,
    ).toBe(true);
  });
  it('keeps K3 compatibility settings strongly typed when resolving a model', () => {
    const providers = resolveProviders({
      providers: [
        {
          ...config.providers[0],
          models: [
            {
              id: 'kimi-k3',
              api: 'openai-completions',
              reasoning: true,
              reasoningProtocol: 'openai-reasoning-effort',
              thinkingLevelMap: {
                off: null,
                minimal: 'low',
                low: 'low',
                medium: 'high',
                high: 'max',
              },
              compat: {
                maxTokensField: 'max_completion_tokens',
                supportsTemperature: false,
                requiresReasoningContentOnAssistantMessages: true,
              },
            },
          ],
        },
      ],
    });
    expect(providers[0]?.models[0]?.compat).toMatchObject({
      maxTokensField: 'max_completion_tokens',
    });
  });
});
