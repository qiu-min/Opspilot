import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ExecuteTurn, type ExcelResource, type TurnExecutionEvent } from '@opspilot/application';
import type { Request, Response } from 'express';

import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { EXCEL_RESOURCE_PATH_RESOLVER, type ExcelResourcePathResolver } from '../sessions/excel-resource-path-resolver.js';
import {
  mapExecuteTurnRequest,
  mapExecuteTurnResult,
  type ExecuteTurnResponse,
} from './turn.mapper.js';
import { serializeTurnExecutionEvent } from './turn-event.serializer.js';
import { executeTurnRequestSchema, type ExecuteTurnRequest } from './turn.schemas.js';

const SSE_ERROR_MESSAGE = 'Internal server error.';

/** HTTP boundary for application-level Turns owned by a Session. */
@Controller()
export class TurnsController {
  constructor(
    private readonly executeTurn: ExecuteTurn,
    @Inject(EXCEL_RESOURCE_PATH_RESOLVER)
    private readonly excelResourcePathResolver: ExcelResourcePathResolver,
  ) {}

  @Post('turns')
  @HttpCode(200)
  async runTurn(
    @Body(new ZodValidationPipe(executeTurnRequestSchema)) request: ExecuteTurnRequest,
  ): Promise<ExecuteTurnResponse> {
    return await this.runTurnForSession(request);
  }

  @Post('sessions/:sessionId/turns')
  @HttpCode(200)
  async runSessionTurn(
    @Param('sessionId', new ParseUUIDPipe({ version: '4' })) sessionId: string,
    @Body(new ZodValidationPipe(executeTurnRequestSchema)) request: ExecuteTurnRequest,
  ): Promise<ExecuteTurnResponse> {
    return await this.runTurnForSession(request, sessionId);
  }

  @Post('turns/stream')
  @HttpCode(200)
  async streamTurn(
    @Body(new ZodValidationPipe(executeTurnRequestSchema)) request: ExecuteTurnRequest,
    @Req() incomingRequest: Request,
    @Res() response: Response,
  ): Promise<void> {
    await this.streamTurnForSession(request, incomingRequest, response);
  }

  @Post('sessions/:sessionId/turns/stream')
  @HttpCode(200)
  async streamSessionTurn(
    @Param('sessionId', new ParseUUIDPipe({ version: '4' })) sessionId: string,
    @Body(new ZodValidationPipe(executeTurnRequestSchema)) request: ExecuteTurnRequest,
    @Req() incomingRequest: Request,
    @Res() response: Response,
  ): Promise<void> {
    await this.streamTurnForSession(request, incomingRequest, response, sessionId);
  }

  private async runTurnForSession(
    request: ExecuteTurnRequest,
    sessionId?: string,
  ): Promise<ExecuteTurnResponse> {
    this.assertRouteSessionIdentity(request, sessionId);
    const result = await this.executeTurn.execute(this.mapRequest(request, sessionId));
    return mapExecuteTurnResult(result);
  }

  private async streamTurnForSession(
    request: ExecuteTurnRequest,
    incomingRequest: Request,
    response: Response,
    sessionId?: string,
  ): Promise<void> {
    this.assertRouteSessionIdentity(request, sessionId);
    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no');

    let disconnected = false;
    let started = false;
    const onClose = (): void => {
      disconnected = true;
    };

    incomingRequest.on('close', onClose);
    response.on('close', onClose);

    try {
      const result = await this.executeTurn.execute(this.mapRequest(request, sessionId), {
        onEvent: (event: TurnExecutionEvent) => {
          if (disconnected || !canWrite(response)) return;
          if (writeSsePayload(response, event.type, serializeTurnExecutionEvent(event))) {
            started = true;
          } else {
            disconnected = true;
          }
        },
      });

      if (!disconnected && writeSseEvent(response, 'done', mapExecuteTurnResult(result))) {
        started = true;
      }
      endResponse(response);
    } catch (error: unknown) {
      if (!started && !response.headersSent && !disconnected) throw error;
      if (!disconnected) writeSseEvent(response, 'error', { message: SSE_ERROR_MESSAGE });
      endResponse(response);
    } finally {
      incomingRequest.off('close', onClose);
      response.off('close', onClose);
    }
  }

  private mapRequest(request: ExecuteTurnRequest, sessionId?: string) {
    const excelResource: ExcelResource | undefined =
      request.excelResource === undefined
        ? undefined
        : this.excelResourcePathResolver.resolve(request.excelResource);
    return mapExecuteTurnRequest(request, excelResource, sessionId);
  }

  private assertRouteSessionIdentity(
    request: ExecuteTurnRequest,
    sessionId: string | undefined,
  ): void {
    if (sessionId !== undefined && request.sessionId !== undefined && request.sessionId !== sessionId) {
      throw new BadRequestException('Route sessionId must match body sessionId.');
    }
  }
}

function canWrite(response: Response): boolean {
  return !response.writableEnded && !response.destroyed;
}

function writeSseEvent(response: Response, eventType: string, data: unknown): boolean {
  return writeSsePayload(response, eventType, JSON.stringify(data));
}

function writeSsePayload(response: Response, eventType: string, serialized: string): boolean {
  if (!canWrite(response)) return false;
  try {
    response.write(`event: ${eventType}\ndata: ${serialized}\n\n`);
    return true;
  } catch {
    return false;
  }
}

function endResponse(response: Response): void {
  if (canWrite(response)) response.end();
}
