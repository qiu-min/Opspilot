import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ExecuteTurn,
  SubscribeTurnStream,
  type ExcelResource,
  type TurnStreamEvent,
} from '@opspilot/application';
import type { Request, Response } from 'express';

import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import {
  EXCEL_RESOURCE_PATH_RESOLVER,
  type ExcelResourcePathResolver,
} from '../sessions/excel-resource-path-resolver.js';
import {
  mapExecuteTurnRequest,
  mapExecuteTurnResult,
  type ExecuteTurnResponse,
} from './turn.mapper.js';
import { executeTurnRequestSchema, type ExecuteTurnRequest } from './turn.schemas.js';

/** HTTP boundary for application-level Turns owned by a Session. */
@Controller()
export class TurnsController {
  constructor(
    private readonly executeTurn: ExecuteTurn,
    @Inject(EXCEL_RESOURCE_PATH_RESOLVER)
    private readonly excelResourcePathResolver: ExcelResourcePathResolver,
    private readonly subscribeTurnStream: SubscribeTurnStream,
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

  /** Reattaches to an existing live Turn without starting or cancelling execution. */
  @Get('turns/:turnId/stream')
  async reattachTurnStream(
    @Param('turnId') turnId: string,
    @Query('after') after: string | undefined,
    @Req() incomingRequest: Request,
    @Res() response: Response,
  ): Promise<void> {
    const afterSequence = parseAfterSequence(after);
    const stream: AsyncIterable<TurnStreamEvent> = this.subscribeTurnStream.execute(
      turnId,
      afterSequence,
    );

    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no');

    let disconnected = false;
    const iterator = stream[Symbol.asyncIterator]();
    const onClose = (): void => {
      disconnected = true;
      void iterator.return?.();
      endResponse(response);
    };
    incomingRequest.on('aborted', onClose);
    response.on('close', onClose);

    try {
      while (!disconnected) {
        const next = await iterator.next();
        if (next.done) {
          console.info('[turn-stream][agent-http-out] iterator done');
          break;
        }
        console.info(
          `[turn-stream][agent-http-out] turnId=${next.value.turnId} sessionId=${next.value.sessionId} type=${next.value.type} seq=${next.value.sequence}`,
        );

        if (!writeTurnStreamSseEvent(response, next.value)) {
          console.warn(
            `[turn-stream][agent-http-out-failed] turnId=${next.value.turnId} type=${next.value.type} seq=${next.value.sequence}`,
          );
          onClose();
          break;
        }
      }
      endResponse(response);
    } finally {
      await iterator.return?.();
      incomingRequest.off('aborted', onClose);
      response.off('close', onClose);
    }
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
    await this.streamStartedTurnWithHub(request, incomingRequest, response, sessionId);
  }

  /** Starts a Turn and attaches the first client to the same Hub protocol as reattach. */
  private async streamStartedTurnWithHub(
    request: ExecuteTurnRequest,
    incomingRequest: Request,
    response: Response,
    sessionId?: string,
  ): Promise<void> {
    let disconnected = false;
    let iterator: AsyncIterator<TurnStreamEvent> | undefined;
    let resolveStream!: (value: AsyncIterator<TurnStreamEvent>) => void;
    let rejectStream!: (reason: unknown) => void;
    const streamReady = new Promise<AsyncIterator<TurnStreamEvent>>((resolve, reject) => {
      resolveStream = resolve;
      rejectStream = reject;
    });
    const disconnectedError = new Error('SSE subscriber disconnected.');
    const onClose = (): void => {
      disconnected = true;
      void iterator?.return?.();
      rejectStream(disconnectedError);
      endResponse(response);
    };
    incomingRequest.on('aborted', onClose);
    response.on('close', onClose);

    const execution = this.executeTurn.execute(this.mapRequest(request, sessionId), {
      onEvent: (event) => {
        if (event.type !== 'turn_ready' || disconnected) {
          return;
        }
        try {
          const stream = this.subscribeTurnStream.execute(event.turnId, -1);
          iterator = stream[Symbol.asyncIterator]();
          resolveStream(iterator);
        } catch (error: unknown) {
          rejectStream(error);
        }
      },
    });
    void execution.catch((error: unknown) => rejectStream(error));

    try {
      iterator = await streamReady;
      response.setHeader('Content-Type', 'text/event-stream');
      response.setHeader('Cache-Control', 'no-cache, no-transform');
      response.setHeader('Connection', 'keep-alive');
      response.setHeader('X-Accel-Buffering', 'no');

      while (!disconnected) {
        const next = await iterator.next();
        if (next.done) break;
        if (!writeTurnStreamSseEvent(response, next.value)) {
          onClose();
          break;
        }
      }
      if (!disconnected) await execution;
      endResponse(response);
    } catch (error: unknown) {
      if (!disconnected && !response.headersSent) throw error;
    } finally {
      await iterator?.return?.();
      incomingRequest.off('aborted', onClose);
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
    if (
      sessionId !== undefined &&
      request.sessionId !== undefined &&
      request.sessionId !== sessionId
    ) {
      throw new BadRequestException('Route sessionId must match body sessionId.');
    }
  }
}

function canWrite(response: Response): boolean {
  return !response.writableEnded && !response.destroyed;
}

function writeSsePayload(
  response: Response,
  eventType: string,
  serialized: string,
  prefix = '',
): boolean {
  if (!canWrite(response)) return false;
  try {
    response.write(`${prefix}event: ${eventType}\ndata: ${serialized}\n\n`);
    return true;
  } catch {
    return false;
  }
}

function endResponse(response: Response): void {
  if (canWrite(response)) response.end();
}

function parseAfterSequence(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^-?\d+$/.test(value)) throw new BadRequestException('after must be an integer.');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < -1) {
    throw new BadRequestException('after must be an integer greater than or equal to -1.');
  }
  return parsed;
}

function writeTurnStreamSseEvent(response: Response, event: TurnStreamEvent): boolean {
  return writeSsePayload(response, event.type, JSON.stringify(event), `id: ${event.sequence}\n`);
}
