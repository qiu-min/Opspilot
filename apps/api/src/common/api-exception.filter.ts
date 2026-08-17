import {
  ArgumentsHost,
  Catch,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { ExceptionFilter } from '@nestjs/common';
import { IncidentNotFoundError } from '@opspilot/application';
import type { Response } from 'express';

import type { ApiErrorCode, ApiErrorResponse } from './api-error.js';
import { ensureRequestId, type RequestWithContext } from './request-context.middleware.js';
import { RequestValidationError } from './zod-validation.pipe.js';

interface MappedError {
  readonly statusCode: number;
  readonly code: ApiErrorCode;
  readonly message: string;
  readonly details?: Record<string, readonly string[]>;
}

@Catch()
@Injectable()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<RequestWithContext>();
    const response = context.getResponse<Response>();
    const mapped = mapException(exception);
    const body: ApiErrorResponse = {
      statusCode: mapped.statusCode,
      code: mapped.code,
      message: mapped.message,
      requestId: ensureRequestId(request),
      timestamp: new Date().toISOString(),
      ...(mapped.details ? { details: mapped.details } : {}),
    };

    response.status(mapped.statusCode).json(body);
  }
}

function mapException(exception: unknown): MappedError {
  if (exception instanceof RequestValidationError) {
    return {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed.',
      details: exception.details,
    };
  }
  if (
    exception instanceof IncidentNotFoundError ||
    exception instanceof NotFoundException ||
    (exception instanceof Error && exception.name === 'IncidentNotFoundError')
  ) {
    return { statusCode: 404, code: 'NOT_FOUND', message: 'Resource not found.' };
  }
  if (exception instanceof ConflictException) {
    const response = exception.getResponse();
    const code: ApiErrorCode =
      typeof response === 'object' &&
      response !== null &&
      (response as Record<string, unknown>).code === 'IDEMPOTENCY_CONFLICT'
        ? 'IDEMPOTENCY_CONFLICT'
        : 'CONFLICT';
    return { statusCode: 409, code, message: 'Conflict.' };
  }
  if (exception instanceof HttpException && exception.getStatus() === 400) {
    return { statusCode: 400, code: 'VALIDATION_ERROR', message: 'Request validation failed.' };
  }
  return { statusCode: 500, code: 'INTERNAL_ERROR', message: 'Internal server error.' };
}
