import { Controller, Get, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  CreateSession,
  GetActiveTurn,
  GetSessionHistory,
  type ActiveTurnStreamSnapshot,
  type SessionHistoryProjection,
} from '@opspilot/application';

/** Internal Agent Service endpoint used by Backend to restore a session history. */
@Controller('sessions')
export class SessionsController {
  constructor(
    @Optional() @Inject(CreateSession) private readonly createSession: CreateSession | undefined,
    private readonly getSessionHistory: GetSessionHistory,
    private readonly getActiveTurn: GetActiveTurn,
  ) {}

  @Post()
  @HttpCode(201)
  create(): { readonly sessionId: string; readonly createdAt: string; readonly updatedAt: string } {
    if (this.createSession === undefined) throw new Error('CreateSession is not configured.');
    return this.createSession.execute();
  }

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
