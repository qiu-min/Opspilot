import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { loadRuntimeConfig } from './runtime-config.js';
import { createApiRuntimeModule } from './runtime-module.js';

async function bootstrap(): Promise<void> {
  const config = loadRuntimeConfig();
  const module = await createApiRuntimeModule(config);
  const app = await NestFactory.create(module);

  app.enableShutdownHooks();
  await app.listen(config.port, config.host);

  console.info(
    `[agent-service] listening on ${config.host}:${config.port}; ` +
      `sessions=${config.sessionDirectory}; ` +
      `model=${config.defaultProviderId}/${config.defaultModelId}`,
  );
}

await bootstrap();
