import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ExcelWorkingResourceManager,
  ExcelWorkingResourceSourceMismatchError,
} from '@opspilot/application';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ExcelWorkingResourceStoreError,
  FileSystemExcelWorkingResourceStore,
} from '../src/index.js';

const directories: string[] = [];

describe('FileSystemExcelWorkingResourceStore', () => {
  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it('persists a first copy, keeps the source immutable, and does not recopy later', async () => {
    const { manager, sourcePath, workspaceRoot } = await createManager();
    const request = resourceRequest('session-a', 'file-1', sourcePath);

    await expect(manager.resolveReadablePath(request)).resolves.toBe(sourcePath);
    const created = await manager.ensureWritableResource(request);
    await writeFile(created.workingPath, 'working copy changed', 'utf8');
    const reused = await manager.ensureWritableResource(request);

    expect(created.revision).toBe(0);
    expect(reused).toEqual(created);
    await expect(readFile(sourcePath, 'utf8')).resolves.toBe('source workbook');
    await expect(readFile(created.workingPath, 'utf8')).resolves.toBe('working copy changed');
    await expect(manager.resolveReadablePath(request)).resolves.toBe(created.workingPath);

    const metadata = JSON.parse(
      await readFile(
        join(workspaceRoot, 'session-a', 'resources', 'file-1', 'metadata.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      version: 1,
      sessionId: 'session-a',
      sourceResourceId: 'file-1',
      sourcePath,
      workingPath: created.workingPath,
      revision: 0,
    });
  });

  it('isolates different Sessions and resources', async () => {
    const { manager, sourcePath } = await createManager();
    const sessionAResource = await manager.ensureWritableResource(
      resourceRequest('session-a', 'file-1', sourcePath),
    );
    const sessionBResource = await manager.ensureWritableResource(
      resourceRequest('session-b', 'file-1', sourcePath),
    );
    const sessionAOtherResource = await manager.ensureWritableResource(
      resourceRequest('session-a', 'file-2', sourcePath),
    );

    await writeFile(sessionAResource.workingPath, 'A changed', 'utf8');

    expect(sessionAResource.workingPath).not.toBe(sessionBResource.workingPath);
    expect(sessionAResource.workingPath).not.toBe(sessionAOtherResource.workingPath);
    await expect(readFile(sessionBResource.workingPath, 'utf8')).resolves.toBe('source workbook');
    await expect(readFile(sessionAOtherResource.workingPath, 'utf8')).resolves.toBe(
      'source workbook',
    );
  });

  it('recovers metadata and revision after a store is recreated', async () => {
    const { manager, sourcePath, workspaceRoot } = await createManager();
    const request = resourceRequest('session-a', 'file-1', sourcePath);
    await manager.ensureWritableResource(request);
    await manager.markModified(request);
    await manager.markModified(request);

    const restartedStore = new FileSystemExcelWorkingResourceStore(workspaceRoot);
    const recovered = await restartedStore.get('session-a', 'file-1');

    expect(recovered).toMatchObject({
      sessionId: 'session-a',
      sourceResourceId: 'file-1',
      sourcePath,
      workingPath: join(workspaceRoot, 'session-a', 'resources', 'file-1', 'working.xlsx'),
      revision: 2,
    });
  });

  it('rejects source identity changes and unsafe workspace paths', async () => {
    const { manager, sourcePath, workspaceRoot } = await createManager();
    await manager.ensureWritableResource(resourceRequest('session-a', 'file-1', sourcePath));

    await expect(
      manager.ensureWritableResource(
        resourceRequest('session-a', 'file-1', join(workspaceRoot, 'different.xlsx')),
      ),
    ).rejects.toBeInstanceOf(ExcelWorkingResourceSourceMismatchError);
  });

  it('serializes concurrent first creation to one working file and metadata', async () => {
    const { manager, sourcePath, workspaceRoot } = await createManager();
    const request = resourceRequest('session-a', 'file-1', sourcePath);
    const resources = await Promise.all([
      manager.ensureWritableResource(request),
      manager.ensureWritableResource(request),
      manager.ensureWritableResource(request),
    ]);

    expect(new Set(resources.map((resource) => resource.workingPath))).toHaveLength(1);
    expect(new Set(resources.map((resource) => resource.revision))).toEqual(new Set([0]));
    await expect(
      readFile(join(workspaceRoot, 'session-a', 'resources', 'file-1', 'working.xlsx'), 'utf8'),
    ).resolves.toBe('source workbook');
  });

  it('returns null for missing metadata and rejects metadata path tampering', async () => {
    const { manager, sourcePath, workspaceRoot } = await createManager();
    const store = new FileSystemExcelWorkingResourceStore(workspaceRoot);
    await expect(store.get('session-a', 'file-1')).resolves.toBeNull();
    const resource = await manager.ensureWritableResource(
      resourceRequest('session-a', 'file-1', sourcePath),
    );
    const metadataPath = join(workspaceRoot, 'session-a', 'resources', 'file-1', 'metadata.json');
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as Record<string, unknown>;
    metadata.workingPath = join(workspaceRoot, '..', 'outside.xlsx');
    await writeFile(metadataPath, `${JSON.stringify(metadata)}\n`, 'utf8');

    await expect(store.get('session-a', 'file-1')).rejects.toThrow(ExcelWorkingResourceStoreError);
    expect(resource.workingPath).toContain(join('session-a', 'resources', 'file-1'));
    await expect(store.get('../outside', 'file-1')).rejects.toThrow(/cannot escape workspaceRoot/);
  });
});

async function createManager(): Promise<{
  readonly manager: ExcelWorkingResourceManager;
  readonly sourcePath: string;
  readonly workspaceRoot: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'opspilot-excel-working-resource-'));
  directories.push(root);
  const sourcePath = join(root, 'source.xlsx');
  const workspaceRoot = join(root, 'workspaces');
  await writeFile(sourcePath, 'source workbook', 'utf8');
  const store = new FileSystemExcelWorkingResourceStore(workspaceRoot);
  return {
    manager: new ExcelWorkingResourceManager({ store, fileOperator: store }),
    sourcePath,
    workspaceRoot,
  };
}

function resourceRequest(
  sessionId: string,
  sourceResourceId: string,
  sourcePath: string,
): { readonly sessionId: string; readonly sourceResourceId: string; readonly sourcePath: string } {
  return { sessionId, sourceResourceId, sourcePath };
}
