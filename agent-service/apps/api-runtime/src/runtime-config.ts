import { z } from 'zod';

const defaultPort = 3000;
const defaultHost = '127.0.0.1';
const defaultSessionDirectory = 'data/sessions';
const defaultModelConfigPath = 'config/model-providers.json';

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
    port: environment.PORT,
    host: environment.HOST,
    sessionDirectory: environment.SESSION_DIRECTORY,
    modelConfigPath: environment.MODEL_CONFIG_PATH,
    defaultProviderId: environment.DEFAULT_MODEL_PROVIDER,
    defaultModelId: environment.DEFAULT_MODEL_ID,
  });

  if (!parsed.success) {
    throw new Error('Runtime configuration is invalid.', { cause: parsed.error });
  }

  return parsed.data;
}
