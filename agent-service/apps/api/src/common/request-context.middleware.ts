import { Injectable } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export interface RequestWithContext extends Request {
  requestId: string;
}

const requestIdSchema = z.uuid();

export function ensureRequestId(request: Partial<RequestWithContext>): string {
  request.requestId ??= readRequestIdHeader(request) ?? randomUUID();
  return request.requestId;
}

function readRequestIdHeader(request: Partial<Request>): string | undefined {
  const value = request.headers?.['x-request-id'];
  return typeof value === 'string' && requestIdSchema.safeParse(value).success ? value : undefined;
}

@Injectable()
export class RequestContextMiddleware {
  use(request: RequestWithContext, response: Response, next: NextFunction): void {
    response.setHeader('X-Request-Id', ensureRequestId(request));
    next();
  }
}
