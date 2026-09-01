import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FileSystemExcelResourcePathResolver } from '../src/files/excel-resource-path-resolver.js';

describe('FileSystemExcelResourcePathResolver', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it('resolves an existing relative storage path within the shared root', async () => {
    const sharedStorageRoot = await createTemporaryDirectory();
    const relativePath = join('uploads', 'report.xlsx');
    const filePath = join(sharedStorageRoot, relativePath);
    await mkdir(join(sharedStorageRoot, 'uploads'), { recursive: true });
    await writeFile(filePath, 'test workbook');

    const resource = new FileSystemExcelResourcePathResolver(sharedStorageRoot).resolve({
      id: 'file-1',
      storagePath: relativePath,
    });

    expect(resource).toEqual({ id: 'file-1', filePath });
  });

  it.each([
    '../outside.xlsx',
    '..\\outside.xlsx',
    '/outside.xlsx',
    'C:\\shared\\outside.xlsx',
    'nested/../../outside.xlsx',
  ])('rejects unsafe storage path %s', (storagePath) => {
    const resolver = new FileSystemExcelResourcePathResolver('shared-storage');

    expect(() => resolver.resolve({ id: 'file-1', storagePath })).toThrow(
      'must remain within sharedStorageRoot',
    );
  });

  it('rejects a missing file and a directory', async () => {
    const sharedStorageRoot = await createTemporaryDirectory();
    const resolver = new FileSystemExcelResourcePathResolver(sharedStorageRoot);

    expect(() => resolver.resolve({ id: 'missing', storagePath: 'missing.xlsx' })).toThrow(
      'does not exist',
    );

    await mkdir(join(sharedStorageRoot, 'folder'));
    expect(() => resolver.resolve({ id: 'folder', storagePath: 'folder' })).toThrow('regular file');
  });

  async function createTemporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'opspilot-excel-resource-'));
    temporaryDirectories.push(directory);
    return directory;
  }
});
