import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ExcelSourceResourceStoreError,
  FileSystemExcelSourceResourceStore,
} from '../src/index.js';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

describe('FileSystemExcelSourceResourceStore', () => {
  it('persists multiple Session Excel source locators across a new store instance', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opspilot-excel-sources-'));
    roots.push(root);
    const sessionId = '11111111-1111-4111-8111-111111111111';
    const first = { id: 'workbook-a', filePath: 'C:/shared/a.xlsx' } as const;
    const second = { id: 'workbook-b', filePath: 'C:/shared/b.xlsx' } as const;

    const store = new FileSystemExcelSourceResourceStore(root);
    await store.save(sessionId, first);
    await store.save(sessionId, second);

    const restarted = new FileSystemExcelSourceResourceStore(root);
    await expect(restarted.get(sessionId, first.id)).resolves.toEqual(first);
    await expect(restarted.get(sessionId, second.id)).resolves.toEqual(second);
    await expect(restarted.get(sessionId, 'missing')).resolves.toBeNull();
  });

  it('returns null for a Session without a locator file and rejects unsafe Session ids', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opspilot-excel-sources-'));
    roots.push(root);
    const store = new FileSystemExcelSourceResourceStore(root);

    await expect(store.get('22222222-2222-4222-8222-222222222222', 'workbook-a')).resolves.toBeNull();
    await expect(store.get('../escape', 'workbook-a')).rejects.toBeInstanceOf(
      ExcelSourceResourceStoreError,
    );
  });
});
