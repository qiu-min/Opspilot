import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { GetSessionHistory, type SessionHistoryProjection } from '@opspilot/application';

/** Internal Agent Service endpoint used by Backend to restore a session history. */
@Controller('sessions')
export class SessionsController {
  constructor(private readonly getSessionHistory: GetSessionHistory) {}

  @Get(':sessionId/history')
  getHistory(
    @Param('sessionId', new ParseUUIDPipe({ version: '4' })) sessionId: string,
  ): SessionHistoryProjection {
    return this.getSessionHistory.execute(sessionId);
  }
}
