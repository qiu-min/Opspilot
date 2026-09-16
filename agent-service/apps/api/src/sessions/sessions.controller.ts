import {
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Optional,
  Param,
  ParseUUIDPipe,
  Post,
  StreamableFile,
} from '@nestjs/common';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import {
  CreateSession,
  GetExcelResourceContent,
  GetActiveTurn,
  GetSessionHistory,
  type ActiveTurnStreamSnapshot,
  type SessionHistoryResult,
} from '@opspilot/application';
import { basename } from 'node:path';

/** Internal Agent Service endpoint used by Backend to restore a session history. */
@Controller('sessions')
export class SessionsController {
  constructor(
    @Optional() @Inject(CreateSession) private readonly createSession: CreateSession | undefined,
    private readonly getSessionHistory: GetSessionHistory,
    private readonly getActiveTurn: GetActiveTurn,
    @Inject(GetExcelResourceContent)
    private readonly getExcelResourceContent: GetExcelResourceContent,
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
  ): SessionHistoryResult {
    return this.getSessionHistory.execute(sessionId);
  }

  @Get(':sessionId/resources/:resourceId/content')
  async getResourceContent(
    @Param('sessionId', new ParseUUIDPipe({ version: '4' })) sessionId: string,
    @Param('resourceId') resourceId: string,
  ): Promise<StreamableFile> {
    const content = await this.getExcelResourceContent.execute(sessionId, resourceId);
    await assertReadableFile(content.filePath);
    const fileName = sanitizeFileName(content.fileName);
    return new StreamableFile(createReadStream(content.filePath), {
      type: content.contentType,
      disposition: `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    });
  }
}

async function assertReadableFile(filePath: string): Promise<void> {
  try {
    const file = await stat(filePath);
    if (!file.isFile()) throw new NotFoundException('Excel resource file was not found.');
  } catch (error: unknown) {
    if (error instanceof NotFoundException) throw error;
    if (isFileNotFoundError(error)) throw new NotFoundException('Excel resource file was not found.');
    throw error;
  }
}

function sanitizeFileName(fileName: string): string {
  const safeName = basename(fileName).replace(/[\r\n"]/g, '_');
  return safeName.length === 0 ? 'workbook.xlsx' : safeName;
}

function isFileNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
