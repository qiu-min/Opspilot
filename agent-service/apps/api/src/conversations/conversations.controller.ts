import { Body, Controller, Optional, Post, Req, Res } from '@nestjs/common';
import { RunConversationTurn } from '@opspilot/application';
import type { Request, Response } from 'express';

import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import {
  mapConversationTurnRequest,
  mapConversationTurnResult,
  type ConversationTurnResponse,
} from './conversation.mapper.js';
import {
  conversationTurnRequestSchema,
  type ConversationTurnRequest,
} from './conversation.schemas.js';

const SSE_ERROR_MESSAGE = 'Internal server error.';

@Controller('conversations')
export class ConversationsController {
  constructor(
    @Optional()
    private readonly runConversationTurn?: RunConversationTurn,
  ) {}

  @Post('turns')
  async runTurn(
    @Body(new ZodValidationPipe(conversationTurnRequestSchema))
    request: ConversationTurnRequest,
  ): Promise<ConversationTurnResponse> {
    const result = await this.getRunConversationTurn().execute(mapConversationTurnRequest(request));
    return mapConversationTurnResult(result);
  }

  @Post('turns/stream')
  async streamTurn(
    @Body(new ZodValidationPipe(conversationTurnRequestSchema))
    request: ConversationTurnRequest,
    @Req() incomingRequest: Request,
    @Res() response: Response,
  ): Promise<void> {
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
      const result = await this.getRunConversationTurn().execute(
        mapConversationTurnRequest(request),
        {
          onEvent: (event) => {
            if (disconnected || !canWrite(response)) return;
            if (writeSseEvent(response, event.type, event)) {
              started = true;
            } else {
              disconnected = true;
            }
          },
        },
      );

      if (
        !disconnected &&
        writeSseEvent(response, 'done', {
          sessionId: result.sessionId,
          leafId: result.leafId,
        })
      ) {
        started = true;
      }

      endResponse(response);
    } catch (error: unknown) {
      if (!started && !response.headersSent && !disconnected) throw error;

      if (!disconnected) {
        writeSseEvent(response, 'error', { message: SSE_ERROR_MESSAGE });
      }
      endResponse(response);
    } finally {
      incomingRequest.off('close', onClose);
      response.off('close', onClose);
    }
  }

  private getRunConversationTurn(): RunConversationTurn {
    if (this.runConversationTurn === undefined) {
      throw new Error('RunConversationTurn application binding is not configured.');
    }
    return this.runConversationTurn;
  }
}

function canWrite(response: Response): boolean {
  return !response.writableEnded && !response.destroyed;
}

function writeSseEvent(response: Response, eventType: string, data: unknown): boolean {
  if (!canWrite(response)) return false;

  const serialized = JSON.stringify(data);
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
