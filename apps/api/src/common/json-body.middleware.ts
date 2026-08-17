import { Injectable } from '@nestjs/common';
import type { NextFunction, Response } from 'express';

import type { ApiErrorResponse } from './api-error.js';
import { ensureRequestId, type RequestWithContext } from './request-context.middleware.js';

const MAX_JSON_BODY_BYTES = 1_048_576;

@Injectable()
export class JsonBodyMiddleware {
  use(request: RequestWithContext, response: Response, next: NextFunction): void {
    if (request.method === 'GET' || request.method === 'HEAD') {
      next();
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_JSON_BODY_BYTES) {
        sendValidationError(response, request, 413, 'Request body is too large.');
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (response.headersSent) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        request.body = undefined;
        next();
        return;
      }
      try {
        request.body = JSON.parse(raw) as unknown;
        next();
      } catch {
        sendValidationError(response, request, 400, 'Invalid JSON body.');
      }
    });
    request.on('error', next);
  }
}

function sendValidationError(
  response: Response,
  request: RequestWithContext,
  statusCode: number,
  message: string,
): void {
  const body: ApiErrorResponse = {
    statusCode,
    code: 'VALIDATION_ERROR',
    message,
    requestId: ensureRequestId(request),
    timestamp: new Date().toISOString(),
  };
  response.status(statusCode).json(body);
}
