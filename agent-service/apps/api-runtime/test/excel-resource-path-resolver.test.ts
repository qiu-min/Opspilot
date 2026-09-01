import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';

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

    expect(resource).toEqual({ id: 'file-1', filePath: resolvePath(filePath) });
  });

  it.each([
    '../outside.xlsx',
    '..\\outside.xlsx',
    '/outside.xlsx',
    'C:\\shared\\outside.xlsx',
    'nested/../../outside.xlsx',
  ])('rejects unsafe storage path %s', async (storagePath) => {
    const resolver = new FileSystemExcelResourcePathResolver(await createTemporaryDirectory());

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

  it('rejects a symlink whose real file is outside the shared root', async ({ skip }) => {
    const parentDirectory = await createTemporaryDirectory();
    const sharedStorageRoot = join(parentDirectory, 'shared-root');
    const outsideRoot = join(parentDirectory, 'outside-root');
    const linkDirectory = join(sharedStorageRoot, 'uploads');
    const outsideFile = join(outsideRoot, 'secret.xlsx');
    const linkPath = join(linkDirectory, 'outside.xlsx');
    await mkdir(linkDirectory, { recursive: true });
    await mkdir(outsideRoot, { recursive: true });
    await writeFile(outsideFile, 'secret workbook');

    if (!(await tryCreateFileSymlink(outsideFile, linkPath))) {
      skip();
      return;
    }

    const resolver = new FileSystemExcelResourcePathResolver(sharedStorageRoot);
    expect(() => resolver.resolve({ id: 'file-1', storagePath: 'uploads/outside.xlsx' })).toThrow(
      'must remain within sharedStorageRoot',
    );
  });

  it('resolves a symlink to an in-root file to its canonical path', async ({ skip }) => {
    const sharedStorageRoot = await createTemporaryDirectory();
    const targetDirectory = join(sharedStorageRoot, 'actual');
    const linkDirectory = join(sharedStorageRoot, 'uploads');
    const targetPath = join(targetDirectory, 'report.xlsx');
    const linkPath = join(linkDirectory, 'report.xlsx');
    await mkdir(targetDirectory, { recursive: true });
    await mkdir(linkDirectory, { recursive: true });
    await writeFile(targetPath, 'test workbook');

    if (!(await tryCreateFileSymlink(targetPath, linkPath))) {
      skip();
      return;
    }

    const resource = new FileSystemExcelResourcePathResolver(sharedStorageRoot).resolve({
      id: 'file-1',
      storagePath: 'uploads/report.xlsx',
    });

    expect(resource).toEqual({ id: 'file-1', filePath: resolvePath(targetPath) });
  });

  it('fails clearly when the shared storage root does not exist', () => {
    expect(
      () => new FileSystemExcelResourcePathResolver(join(tmpdir(), `missing-${Date.now()}`)),
    ).toThrow('sharedStorageRoot does not exist or cannot be accessed.');
  });

  async function createTemporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'opspilot-excel-resource-'));
    temporaryDirectories.push(directory);
    return directory;
  }

  async function tryCreateFileSymlink(targetPath: string, linkPath: string): Promise<boolean> {
    try {
      await symlink(targetPath, linkPath, 'file');
      return true;
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error.code === 'EACCES' || error.code === 'EPERM' || error.code === 'ENOTSUP')
      ) {
        return false;
      }

      throw error;
    }
  }
});
