import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isModelGatewayError,
  loadModelGatewayConfig,
  modelGatewayConfigSchema,
  resolveProviders,
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
  ],
};
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
  it('rejects duplicate IDs and invalid configuration files', async () => {
    expect(
      modelGatewayConfigSchema.safeParse({ providers: [config.providers[0], config.providers[0]] })
        .success,
    ).toBe(false);
    const dir = await mkdtemp(join(tmpdir(), 'opspilot-'));
    const path = join(dir, 'providers.json');
    await writeFile(path, '{');
    await expect(loadModelGatewayConfig(path)).rejects.toSatisfy((error: unknown) =>
      isModelGatewayError(error, 'CONFIGURATION'),
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
});
