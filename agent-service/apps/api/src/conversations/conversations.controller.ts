import { Body, Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import { RunConversationTurn } from '@opspilot/application';
import type { Request, Response } from 'express';

import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import {
  mapConversationTurnRequest,
  mapConversationTurnResult,
  type ConversationTurnResponse,
} from './conversation.mapper.js';
import { serializeConversationEvent } from './conversation-event.serializer.js';
import {
  conversationTurnRequestSchema,
  type ConversationTurnRequest,
} from './conversation.schemas.js';

const SSE_ERROR_MESSAGE = 'Internal server error.';

@Controller('conversations')
export class ConversationsController {
  constructor(private readonly runConversationTurn: RunConversationTurn) {}

  @Post('turns')
  @HttpCode(200)
  async runTurn(
    @Body(new ZodValidationPipe(conversationTurnRequestSchema))
    request: ConversationTurnRequest,
  ): Promise<ConversationTurnResponse> {
    const result = await this.runConversationTurn.execute(mapConversationTurnRequest(request));
    return mapConversationTurnResult(result);
  }

  @Post('turns/stream')
  @HttpCode(200)
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
      const result = await this.runConversationTurn.execute(mapConversationTurnRequest(request), {
        onEvent: (event) => {
          if (disconnected || !canWrite(response)) return;
          if (writeSsePayload(response, event.type, serializeConversationEvent(event))) {
            started = true;
          } else {
            disconnected = true;
          }
        },
      });

      if (
        !disconnected &&
        writeSseEvent(response, 'done', {
          sessionId: result.sessionId,
          leafId: result.leafId,
          status: mapConversationTurnResult(result).status,
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
