import { basename } from 'node:path';

import type { SessionStore } from '../../session/ports/session-store.js';
import type { ExcelResource } from '../../tools/excel-resource.js';
import {
  ExcelResourceContentNotFoundError,
  ExcelResourceNotFoundError,
} from './excel-working-resource-errors.js';
import type { ExcelSourceResourceStore } from './excel-source-resource-store.js';
import { ExcelWorkingResourceManager } from './excel-working-resource-manager.js';

export const EXCEL_WORKBOOK_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Server-only description of the workbook that should be streamed to a caller. */
export interface ExcelResourceContent {
  readonly filePath: string;
  readonly fileName: string;
  readonly contentType: typeof EXCEL_WORKBOOK_CONTENT_TYPE;
}

export interface GetExcelResourceContentDependencies {
  readonly sessionStore: SessionStore;
  readonly excelSourceResourceStore: ExcelSourceResourceStore;
  readonly workingResourceManager: Pick<
    ExcelWorkingResourceManager,
    'resolveReadablePath'
  >;
}

/** Resolves the current committed workbook without exposing storage details to HTTP clients. */
export class GetExcelResourceContent {
  private readonly sessionStore: SessionStore;
  private readonly excelSourceResourceStore: ExcelSourceResourceStore;
  private readonly workingResourceManager: Pick<
    ExcelWorkingResourceManager,
    'resolveReadablePath'
  >;

  public constructor(dependencies: GetExcelResourceContentDependencies) {
    this.sessionStore = dependencies.sessionStore;
    this.excelSourceResourceStore = dependencies.excelSourceResourceStore;
    this.workingResourceManager = dependencies.workingResourceManager;
  }

  /** Returns source content until a committed revision exists, then that revision only. */
  public async execute(sessionId: string, resourceId: string): Promise<ExcelResourceContent> {
    const session = this.sessionStore.load(sessionId);
    const registeredResource = session
      .getResources()
      .find((resource) => resource.id === resourceId);
    if (registeredResource === undefined || registeredResource.kind !== 'excel') {
      throw new ExcelResourceNotFoundError(sessionId, resourceId);
    }

    const sourceResource = await this.excelSourceResourceStore.get(sessionId, resourceId);
    if (sourceResource === null || sourceResource.id !== resourceId) {
      throw new ExcelResourceNotFoundError(sessionId, resourceId);
    }

    let filePath: string;
    try {
      filePath = await this.workingResourceManager.resolveReadablePath({
        sessionId,
        sourceResourceId: resourceId,
        sourcePath: sourceResource.filePath,
      });
    } catch (error: unknown) {
      if (hasFileNotFoundCause(error)) {
        throw new ExcelResourceContentNotFoundError(sessionId, resourceId, { cause: error });
      }
      throw error;
    }

    return {
      filePath,
      fileName: getFileName(sourceResource),
      contentType: EXCEL_WORKBOOK_CONTENT_TYPE,
    };
  }
}

function getFileName(resource: ExcelResource): string {
  const fileName = basename(resource.filePath);
  return fileName.length === 0 ? 'workbook.xlsx' : fileName;
}

function hasFileNotFoundCause(error: unknown): boolean {
  let current: unknown = error;
  const visited = new Set<unknown>();
  while (isErrorLike(current) && !visited.has(current)) {
    visited.add(current);
    if (current.code === 'ENOENT') return true;
    current = current.cause;
  }
  return false;
}

function isErrorLike(value: unknown): value is { readonly code?: unknown; readonly cause?: unknown } {
  return typeof value === 'object' && value !== null;
}
