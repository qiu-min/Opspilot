import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { createApiRuntimeModule } from './runtime-module.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(createApiRuntimeModule(), { bodyParser: false });
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ? Number(process.env.PORT) : 3001);
}

void bootstrap();
