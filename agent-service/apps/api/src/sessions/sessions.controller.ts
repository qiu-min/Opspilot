import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { GetConversationHistory, type ConversationHistoryProjection } from '@opspilot/application';

/** Internal Agent Service endpoint used by Backend to restore a session history. */
@Controller('sessions')
export class SessionsController {
  constructor(private readonly getConversationHistory: GetConversationHistory) {}

  @Get(':sessionId/history')
  getHistory(
    @Param('sessionId', new ParseUUIDPipe({ version: '4' })) sessionId: string,
  ): ConversationHistoryProjection {
    return this.getConversationHistory.execute(sessionId);
  }
}
