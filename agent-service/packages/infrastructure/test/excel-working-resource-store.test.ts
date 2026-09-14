import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ExcelWorkingResourceManager,
  ExcelWorkingResourceSourceMismatchError,
  type ExcelWorkingResource,
  type ExcelWorkingResourceRequest,
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

  it('cleans stale staging and the known legacy initial-copy orphan before retrying', async () => {
    const { manager, sourcePath, workspaceRoot } = await createManager();
    const resourcesDirectory = join(workspaceRoot, 'session-a', 'resources');
    const legacyDirectory = join(resourcesDirectory, 'file-1');
    const staleDirectory = join(resourcesDirectory, '.creating-file-1-stale');
    await mkdir(legacyDirectory, { recursive: true });
    await writeFile(join(legacyDirectory, 'working.xlsx'), 'legacy unpublished copy', 'utf8');
    await mkdir(staleDirectory, { recursive: true });
    await writeFile(join(staleDirectory, 'working.xlsx'), 'stale unpublished copy', 'utf8');

    const resource = await manager.ensureWritableResource(
      resourceRequest('session-a', 'file-1', sourcePath),
    );
    const entries = await readdir(resourcesDirectory);

    expect(entries).toEqual(['file-1']);
    await expect(readFile(resource.workingPath, 'utf8')).resolves.toBe('source workbook');
    await expect(readFile(join(legacyDirectory, 'metadata.json'), 'utf8')).resolves.toContain(
      '"revision": 0',
    );
  });

  it('removes staging after an abort following a successful copy and allows retry', async () => {
    const { sourcePath, workspaceRoot } = await createManager();
    const store = new FileSystemExcelWorkingResourceStore(workspaceRoot);
    const controller = new AbortController();
    let signalReads = 0;
    const abortingRequest = {
      sessionId: 'session-a',
      sourceResourceId: 'file-1',
      sourcePath,
      get signal(): AbortSignal {
        signalReads += 1;
        if (signalReads === 3) controller.abort();
        return controller.signal;
      },
    };

    await expect(store.initializeWorkingResource(abortingRequest)).rejects.toThrow();
    const resourcesDirectory = join(workspaceRoot, 'session-a', 'resources');
    const entries = await readdir(resourcesDirectory);
    expect(entries).toEqual([]);

    const manager = new ExcelWorkingResourceManager({ store, fileOperator: store });
    await expect(
      manager.ensureWritableResource(resourceRequest('session-a', 'file-1', sourcePath)),
    ).resolves.toMatchObject({ revision: 0 });
  });

  it('cleans staging when metadata creation fails and allows a later initialization', async () => {
    const { sourcePath, workspaceRoot } = await createManager();
    const request = resourceRequest('session-a', 'file-1', sourcePath);
    const failingStore = new MetadataWriteFailureStore(workspaceRoot);

    await expect(failingStore.initializeWorkingResource(request)).rejects.toThrow(
      'Unable to initialize Excel working resource',
    );
    await expect(readdir(join(workspaceRoot, 'session-a', 'resources'))).resolves.toEqual([]);

    const store = new FileSystemExcelWorkingResourceStore(workspaceRoot);
    const manager = new ExcelWorkingResourceManager({ store, fileOperator: store });
    await expect(manager.ensureWritableResource(request)).resolves.toMatchObject({ revision: 0 });
  });

  it('cleans staging when publication fails after metadata is ready', async () => {
    const { sourcePath, workspaceRoot } = await createManager();
    const request = resourceRequest('session-a', 'file-1', sourcePath);
    const failingStore = new PublishFailureStore(workspaceRoot);

    await expect(failingStore.initializeWorkingResource(request)).rejects.toThrow(
      'Unable to initialize Excel working resource',
    );
    await expect(readdir(join(workspaceRoot, 'session-a', 'resources'))).resolves.toEqual([]);

    const store = new FileSystemExcelWorkingResourceStore(workspaceRoot);
    const manager = new ExcelWorkingResourceManager({ store, fileOperator: store });
    await expect(manager.ensureWritableResource(request)).resolves.toMatchObject({ revision: 0 });
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

class MetadataWriteFailureStore extends FileSystemExcelWorkingResourceStore {
  protected override async writeStagedMetadata(
    _metadataPath: string,
    _resource: ExcelWorkingResource,
  ): Promise<void> {
    throw new Error('metadata write failure');
  }
}

class PublishFailureStore extends FileSystemExcelWorkingResourceStore {
  protected override async publishStagingDirectory(
    _stagingDirectory: string,
    _finalDirectory: string,
    _input: ExcelWorkingResourceRequest,
  ): Promise<void> {
    throw new Error('publish failure');
  }
}
