import { BadRequestException, ConflictException } from '@nestjs/common';
import { IncidentNotFoundError } from '@opspilot/application';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { EventEmitter } from 'node:events';

import { ApiExceptionFilter } from '../src/common/api-exception.filter.js';
import { RequestValidationError, ZodValidationPipe } from '../src/common/zod-validation.pipe.js';
import { RequestContextMiddleware } from '../src/common/request-context.middleware.js';
import { RequestLoggingMiddleware } from '../src/common/request-logging.middleware.js';

describe('ZodValidationPipe', () => {
  const pipe = new ZodValidationPipe(z.object({ id: z.uuid(), page: z.coerce.number().int() }));

  it.each([
    ['body', { id: '0d9ef0c6-ce1b-4906-b472-83e651731e88', page: '1' }],
    ['params', { id: '0d9ef0c6-ce1b-4906-b472-83e651731e88', page: 2 }],
    ['query', { id: '0d9ef0c6-ce1b-4906-b472-83e651731e88', page: '3' }],
  ])('validates %s input', (_source, value) => {
    expect(pipe.transform(value)).toMatchObject({ page: expect.any(Number) });
  });

  it('returns safe field details for invalid input', () => {
    try {
      pipe.transform({ id: 'invalid', page: 'not-a-number' });
      throw new Error('expected validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        code: 'VALIDATION_ERROR',
        details: { id: expect.any(Array), page: expect.any(Array) },
      });
    }
  });
});

describe('request context and lifecycle logging', () => {
  it('uses a valid client request ID, replaces an invalid one, and always writes the response header', () => {
    const validId = '0d9ef0c6-ce1b-4906-b472-83e651731e88';
    const validHeaders: Record<string, string> = {};
    new RequestContextMiddleware().use(
      { headers: { 'x-request-id': validId } } as never,
      { setHeader: (name: string, value: string) => (validHeaders[name] = value) } as never,
      () => undefined,
    );
    expect(validHeaders['X-Request-Id']).toBe(validId);

    const invalidHeaders: Record<string, string> = {};
    new RequestContextMiddleware().use(
      { headers: { 'x-request-id': 'not-a-uuid' } } as never,
      { setHeader: (name: string, value: string) => (invalidHeaders[name] = value) } as never,
      () => undefined,
    );
    expect(z.uuid().safeParse(invalidHeaders['X-Request-Id']).success).toBe(true);
    expect(invalidHeaders['X-Request-Id']).not.toBe('not-a-uuid');
  });

  it('writes safe request start and completion records without query data', () => {
    const records: Record<string, unknown>[] = [];
    const response = Object.assign(new EventEmitter(), { statusCode: 201 });
    new RequestLoggingMiddleware({ info: (record: Record<string, unknown>) => records.push(record) } as never).use(
      {
        requestId: '0d9ef0c6-ce1b-4906-b472-83e651731e88',
        method: 'GET',
        path: '/incidents/example',
        originalUrl: '/incidents/example?token=must-not-log',
      } as never,
      response as never,
      () => undefined,
    );
    response.emit('finish');

    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ event: 'api.request.started', path: '/incidents/example' });
    expect(records[1]).toMatchObject({
      event: 'api.request.completed',
      statusCode: 201,
      durationMs: expect.any(Number),
    });
    expect(JSON.stringify(records)).not.toContain('must-not-log');
  });
});

describe('ApiExceptionFilter', () => {
  it.each([
    [new BadRequestException(), 400, 'VALIDATION_ERROR'],
    [new RequestValidationError({ title: ['Required'] }), 400, 'VALIDATION_ERROR'],
    [new IncidentNotFoundError('0d9ef0c6-ce1b-4906-b472-83e651731e88'), 404, 'NOT_FOUND'],
    [new ConflictException(), 409, 'CONFLICT'],
    [new Error('Prisma database password secret'), 500, 'INTERNAL_ERROR'],
  ])('formats %s safely', (exception, statusCode, code) => {
    let captured: { status: number; body: Record<string, unknown> } | undefined;
    const mockResponse = {
      status(status: number) {
        return {
          json(body: Record<string, unknown>) {
            captured = { status, body };
          },
        };
      },
    };
    const host = {
      switchToHttp: () => ({
        getRequest: () => ({}),
        getResponse: () => mockResponse,
      }),
    };

    new ApiExceptionFilter().catch(exception, host as never);

    expect(captured).toMatchObject({
      status: statusCode,
      body: { statusCode, code, requestId: expect.any(String), timestamp: expect.any(String) },
    });
    if (statusCode === 500) {
      expect(JSON.stringify(captured)).not.toContain('secret');
    }
    if (exception instanceof RequestValidationError) {
      expect(captured?.body.details).toEqual({ title: ['Required'] });
    }
  });
});
