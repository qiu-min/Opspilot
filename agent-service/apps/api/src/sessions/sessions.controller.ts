import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import {
  GetActiveTurn,
  GetSessionHistory,
  type ActiveTurnStreamSnapshot,
  type SessionHistoryProjection,
} from '@opspilot/application';

/** Internal Agent Service endpoint used by Backend to restore a session history. */
@Controller('sessions')
export class SessionsController {
  constructor(
    private readonly getSessionHistory: GetSessionHistory,
    private readonly getActiveTurn: GetActiveTurn,
  ) {}

  @Get(':sessionId/active-turn')
  getActiveTurnSnapshot(
    @Param('sessionId', new ParseUUIDPipe({ version: '4' })) sessionId: string,
  ): { readonly activeTurn: ActiveTurnStreamSnapshot | null } {
    return { activeTurn: this.getActiveTurn.execute(sessionId) };
  }

  @Get(':sessionId/history')
  getHistory(
    @Param('sessionId', new ParseUUIDPipe({ version: '4' })) sessionId: string,
  ): SessionHistoryProjection {
    return this.getSessionHistory.execute(sessionId);
  }
}
