import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ApiModule, EXCEL_RESOURCE_PATH_RESOLVER } from '@opspilot/api';
import { RunConversationTurn } from '@opspilot/application';
import { describe, expect, it } from 'vitest';

import { Test, type TestingModule } from '@nestjs/testing';

import { loadRuntimeConfig, type RuntimeConfig } from '../src/runtime-config.js';
import { FileSystemExcelResourcePathResolver } from '../src/files/excel-resource-path-resolver.js';
import { createApiRuntimeModule } from '../src/runtime-module.js';

const testApiKeyEnvironmentVariable = 'OPSPILOT_RUNTIME_TEST_API_KEY';
const testProviderId = 'test-provider';
const testModelId = 'test-model';

describe('API runtime composition root', () => {
  it('creates the composition root and resolves RunConversationTurn', async () => {
    await withModelConfig(async (config) => {
      const runtimeModule = await createApiRuntimeModule(config);
      const module: TestingModule = await Test.createTestingModule({
        imports: [runtimeModule],
      }).compile();

      expect(module.get(RunConversationTurn)).toBeInstanceOf(RunConversationTurn);
      expect(module.get(EXCEL_RESOURCE_PATH_RESOLVER)).toBeInstanceOf(
        FileSystemExcelResourcePathResolver,
      );
      await module.close();
    });
  });

  it('fails when the configured default model does not exist', async () => {
    await withModelConfig(async (config) => {
      await expect(
        createApiRuntimeModule({ ...config, defaultModelId: 'missing-model' }),
      ).rejects.toThrow(`Default model ${testProviderId}/missing-model is not configured.`);
    });
  });

  it('fails when the model configuration file is missing or invalid', async () => {
    await withTemporaryDirectory(async (directory) => {
      const config = createRuntimeConfig(join(directory, 'missing.json'), directory);
      await expect(createApiRuntimeModule(config)).rejects.toThrow(
        `Unable to read model gateway configuration: ${config.modelConfigPath}`,
      );

      const invalidPath = join(directory, 'invalid.json');
      await writeFile(invalidPath, '{', 'utf8');
      await expect(
        createApiRuntimeModule({ ...config, modelConfigPath: invalidPath }),
      ).rejects.toThrow(`Unable to read model gateway configuration: ${invalidPath}`);
    });
  });

  it('uses stable default paths independent of process.cwd()', async () => {
    const originalWorkingDirectory = process.cwd();
    const temporaryWorkingDirectory = await mkdtemp(join(tmpdir(), 'opspilot-api-runtime-cwd-'));

    try {
      process.chdir(temporaryWorkingDirectory);
      expect(
        loadRuntimeConfig({
          DEFAULT_MODEL_PROVIDER: testProviderId,
          DEFAULT_MODEL_ID: testModelId,
          SESSION_DIRECTORY: '',
          MODEL_CONFIG_PATH: '',
          OPS_PILOT_SHARED_STORAGE_ROOT: temporaryWorkingDirectory,
        }),
      ).toMatchObject({
        sessionDirectory: fileURLToPath(new URL('../../../data/sessions', import.meta.url)),
        modelConfigPath: fileURLToPath(
          new URL('../../../config/model-providers.json', import.meta.url),
        ),
        sharedStorageRoot: temporaryWorkingDirectory,
      });
    } finally {
      process.chdir(originalWorkingDirectory);
      await rm(temporaryWorkingDirectory, { recursive: true, force: true });
    }
  });

  it('allows explicit runtime path overrides', () => {
    expect(
      loadRuntimeConfig({
        SESSION_DIRECTORY: 'custom/sessions',
        MODEL_CONFIG_PATH: 'custom/models.json',
        OPS_PILOT_SHARED_STORAGE_ROOT: 'custom/storage',
        DEFAULT_MODEL_PROVIDER: testProviderId,
        DEFAULT_MODEL_ID: testModelId,
      }),
    ).toMatchObject({
      sessionDirectory: 'custom/sessions',
      modelConfigPath: 'custom/models.json',
      sharedStorageRoot: resolvePath('custom/storage'),
    });
  });

  it('rejects invalid or incomplete runtime environment configuration', () => {
    expect(() =>
      loadRuntimeConfig({
        PORT: 'not-a-port',
        OPS_PILOT_SHARED_STORAGE_ROOT: 'shared/storage',
        DEFAULT_MODEL_PROVIDER: testProviderId,
        DEFAULT_MODEL_ID: testModelId,
      }),
    ).toThrow('Runtime configuration is invalid.');

    expect(() => loadRuntimeConfig({})).toThrow('Runtime configuration is invalid.');
    expect(() =>
      loadRuntimeConfig({
        DEFAULT_MODEL_PROVIDER: testProviderId,
        DEFAULT_MODEL_ID: testModelId,
        OPS_PILOT_SHARED_STORAGE_ROOT: ' ',
      }),
    ).toThrow('OPS_PILOT_SHARED_STORAGE_ROOT is required.');
  });

  it('starts the built entrypoint with the package start script', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { readonly scripts?: { readonly start?: string } };

    expect(packageJson.scripts?.start).toContain('dist/main.js');
  });

  it('requires RunConversationTurn when compiling the API module', async () => {
    await expect(
      Test.createTestingModule({
        imports: [ApiModule.register({ providers: [], exports: [] })],
      }).compile(),
    ).rejects.toThrow(/RunConversationTurn|ConversationsController/);
  });
});

async function withModelConfig(callback: (config: RuntimeConfig) => Promise<void>): Promise<void> {
  await withTemporaryDirectory(async (directory) => {
    const modelConfigPath = join(directory, 'models.json');
    await writeFile(modelConfigPath, JSON.stringify(createModelConfig()), 'utf8');
    await callback(createRuntimeConfig(modelConfigPath, directory));
  });
}

async function withTemporaryDirectory(
  callback: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'opspilot-api-runtime-'));
  const previousApiKey = process.env[testApiKeyEnvironmentVariable];
  process.env[testApiKeyEnvironmentVariable] = 'test-api-key';

  try {
    await callback(directory);
  } finally {
    if (previousApiKey === undefined) {
      delete process.env[testApiKeyEnvironmentVariable];
    } else {
      process.env[testApiKeyEnvironmentVariable] = previousApiKey;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

function createRuntimeConfig(modelConfigPath: string, sessionDirectory: string): RuntimeConfig {
  return {
    port: 3000,
    host: '127.0.0.1',
    sessionDirectory,
    modelConfigPath,
    sharedStorageRoot: sessionDirectory,
    defaultProviderId: testProviderId,
    defaultModelId: testModelId,
  };
}

function createModelConfig(): object {
  return {
    providers: [
      {
        id: testProviderId,
        apiKeyEnv: testApiKeyEnvironmentVariable,
        baseUrl: 'https://provider.example/v1',
        models: [{ id: testModelId, api: 'openai-completions', reasoning: false }],
      },
    ],
  };
}
