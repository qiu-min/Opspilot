import {
  ExcelResourceNotFoundError,
  GetExcelResourceContent,
  Session,
  type ExcelSourceResourceStore,
  type SessionStore,
} from '../src/index.js';
import { describe, expect, it, vi } from 'vitest';

const sessionId = '11111111-1111-4111-8111-111111111111';
const resourceId = 'resource-1';
const sourcePath = 'uploads/sales.xlsx';

describe('GetExcelResourceContent', () => {
  it('returns the source workbook before any committed revision exists', async () => {
    const session = Session.create({ id: sessionId });
    session.registerResource({ id: resourceId, kind: 'excel' });
    const resolveReadablePath = vi.fn(async () => sourcePath);
    const query = createQuery(session, resolveReadablePath);

    await expect(query.execute(sessionId, resourceId)).resolves.toEqual({
      filePath: sourcePath,
      fileName: 'sales.xlsx',
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    expect(resolveReadablePath).toHaveBeenCalledWith({
      sessionId,
      sourceResourceId: resourceId,
      sourcePath,
    });
  });

  it('returns the committed working revision and rejects an unregistered resource', async () => {
    const session = Session.create({ id: sessionId });
    session.registerResource({ id: resourceId, kind: 'excel' });
    const query = createQuery(session, async () => 'workspaces/session/resources/resource-1/revisions/2.xlsx');

    await expect(query.execute(sessionId, resourceId)).resolves.toMatchObject({
      filePath: 'workspaces/session/resources/resource-1/revisions/2.xlsx',
    });
    await expect(query.execute(sessionId, 'missing-resource')).rejects.toBeInstanceOf(
      ExcelResourceNotFoundError,
    );
  });
});

function createQuery(
  session: Session,
  resolveReadablePath: (input: {
    sessionId: string;
    sourceResourceId: string;
    sourcePath: string;
  }) => Promise<string>,
): GetExcelResourceContent {
  const sessionStore: SessionStore = {
    create: () => { throw new Error('not used'); },
    load: () => session,
    appendEntry: () => { throw new Error('not used'); },
    saveMetadata: () => { throw new Error('not used'); },
  };
  const sourceStore: ExcelSourceResourceStore = {
    get: async () => ({ id: resourceId, filePath: sourcePath }),
    save: async () => undefined,
  };
  return new GetExcelResourceContent({
    sessionStore,
    excelSourceResourceStore: sourceStore,
    workingResourceManager: { resolveReadablePath },
  });
}
