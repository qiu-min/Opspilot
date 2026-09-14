import { describe, expect, it } from 'vitest';
import { Session } from '@opspilot/domain';

import { resolveExcelResourceContext, type ExcelSourceResourceStore } from '../src/index.js';

describe('resolveExcelResourceContext', () => {
  it('restores every available registered resource and identifies active separately', async () => {
    const session = Session.create({ id: 'session-1' });
    session.registerResource({ id: 'workbook-a', kind: 'excel' });
    session.registerResource({ id: 'workbook-b', kind: 'excel' });
    session.setActiveResource('workbook-a');
    const resources = new Map([
      ['workbook-a', { id: 'workbook-a', filePath: 'a.xlsx' }],
      ['workbook-b', { id: 'workbook-b', filePath: 'b.xlsx' }],
    ]);
    const store: ExcelSourceResourceStore = {
      get: async (_sessionId, resourceId) => resources.get(resourceId) ?? null,
      save: async () => undefined,
    };

    await expect(resolveExcelResourceContext(session, store)).resolves.toEqual({
      resources: [
        { id: 'workbook-a', filePath: 'a.xlsx' },
        { id: 'workbook-b', filePath: 'b.xlsx' },
      ],
      excelResourceRefs: [
        { id: 'workbook-a', kind: 'excel', alias: 'excel-1' },
        { id: 'workbook-b', kind: 'excel', alias: 'excel-2' },
      ],
      activeResourceId: 'workbook-a',
      activeResource: { id: 'workbook-a', filePath: 'a.xlsx' },
    });
  });

  it('reports a registered resource whose source locator is no longer available', async () => {
    const session = Session.create({ id: 'session-1' });
    session.registerResource({ id: 'workbook-a', kind: 'excel' });
    session.registerResource({ id: 'workbook-b', kind: 'excel' });
    const store: ExcelSourceResourceStore = {
      get: async (_sessionId, resourceId) =>
        resourceId === 'workbook-a' ? { id: resourceId, filePath: 'a.xlsx' } : null,
      save: async () => undefined,
    };

    await expect(resolveExcelResourceContext(session, store)).rejects.toThrow(
      'Excel source locator is registered but not available: workbook-b.',
    );
  });
});
