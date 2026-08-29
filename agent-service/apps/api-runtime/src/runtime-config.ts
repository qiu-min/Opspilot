import { fileURLToPath } from 'node:url';

import { z } from 'zod';

const defaultPort = 3000;
const defaultHost = '127.0.0.1';
const defaultSessionDirectory = fileURLToPath(new URL('../../../data/sessions', import.meta.url));
const defaultModelConfigPath = fileURLToPath(
  new URL('../../../config/model-providers.json', import.meta.url),
);

export const runtimeConfigSchema = z.object({
  port: z.coerce.number().int().min(1).max(65_535).default(defaultPort),
  host: z.string().trim().min(1).default(defaultHost),
  sessionDirectory: z.string().trim().min(1).default(defaultSessionDirectory),
  modelConfigPath: z.string().trim().min(1).default(defaultModelConfigPath),
  defaultProviderId: z.string().trim().min(1),
  defaultModelId: z.string().trim().min(1),
});

export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;

export function loadRuntimeConfig(environment: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const parsed = runtimeConfigSchema.safeParse({
    port: optionalEnvironmentValue(environment.PORT),
    host: optionalEnvironmentValue(environment.HOST),
    sessionDirectory: optionalEnvironmentValue(environment.SESSION_DIRECTORY),
    modelConfigPath: optionalEnvironmentValue(environment.MODEL_CONFIG_PATH),
    defaultProviderId: environment.DEFAULT_MODEL_PROVIDER,
    defaultModelId: environment.DEFAULT_MODEL_ID,
  });

  if (!parsed.success) {
    throw new Error('Runtime configuration is invalid.', { cause: parsed.error });
  }

  return parsed.data;
}

function optionalEnvironmentValue(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value;
}
