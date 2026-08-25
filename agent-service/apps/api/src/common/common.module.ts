import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';

import { ApiExceptionFilter } from './api-exception.filter.js';
import { API_LOGGER, ApiLoggerFactory } from './api-logger.js';
import { JsonBodyMiddleware } from './json-body.middleware.js';
import { RequestContextMiddleware } from './request-context.middleware.js';
import { RequestLoggingMiddleware } from './request-logging.middleware.js';

/**
 * Shared API-level contracts. Concrete infrastructure bindings live in the
 * persistence module so controllers never need to import the database layer.
 */
@Module({
  providers: [
    ApiLoggerFactory,
    { provide: API_LOGGER, useFactory: (factory: ApiLoggerFactory) => factory.create(), inject: [ApiLoggerFactory] },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
  exports: [API_LOGGER],
})
export class CommonModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(RequestContextMiddleware, RequestLoggingMiddleware, JsonBodyMiddleware)
      .forRoutes('*');
  }
}
