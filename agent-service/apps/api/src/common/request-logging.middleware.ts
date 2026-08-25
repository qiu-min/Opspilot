import { Inject, Injectable } from '@nestjs/common';
import type { NextFunction, Response } from 'express';

import { API_LOGGER, type ApiLogger } from './api-logger.js';
import type { RequestWithContext } from './request-context.middleware.js';

@Injectable()
export class RequestLoggingMiddleware {
  constructor(@Inject(API_LOGGER) private readonly logger: ApiLogger) {}

  use(request: RequestWithContext, response: Response, next: NextFunction): void {
    const startedAt = process.hrtime.bigint();
    const context = {
      requestId: request.requestId,
      method: request.method,
      path: request.path,
    };
    this.logger.info({ event: 'api.request.started', ...context });
    response.once('finish', () => {
      this.logger.info({
        event: 'api.request.completed',
        ...context,
        statusCode: response.statusCode,
        durationMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
      });
    });
    next();
  }
}
