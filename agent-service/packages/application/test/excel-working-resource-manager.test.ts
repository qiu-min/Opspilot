import { describe, expect, it } from 'vitest';

import {
  ExcelWorkingResourceManager,
  ExcelWorkingResourceNotFoundError,
  ExcelWorkingResourceSourceMismatchError,
  type ExcelWorkingResource,
  type ExcelWorkingResourceFileOperator,
  type ExcelWorkingResourceRequest,
  type ExcelWorkingResourceStore,
} from '../src/index.js';

describe('ExcelWorkingResourceManager', () => {
  it('reads the immutable source before a working copy exists', async () => {
    const { manager, fileOperator } = createManager();
    const request = resourceRequest('session-a', 'file-1');

    await expect(manager.resolveReadablePath(request)).resolves.toBe(request.sourcePath);
    expect(fileOperator.initializeCount).toBe(0);
  });

  it('creates one copy on the first writable request and reuses it afterwards', async () => {
    const { manager, fileOperator, files } = createManager();
    const request = resourceRequest('session-a', 'file-1');

    const created = await manager.ensureWritableResource(request);
    files.set(created.workingPath, 'changed by the first write');
    const reused = await manager.ensureWritableResource(request);

    expect(created).toEqual({
      sessionId: 'session-a',
      sourceResourceId: 'file-1',
      sourcePath: request.sourcePath,
      workingPath: '/workspace/session-a/resources/file-1/working.xlsx',
      revision: 0,
    });
    expect(reused).toEqual(created);
    expect(files.get(created.workingPath)).toBe('changed by the first write');
    expect(fileOperator.initializeCount).toBe(1);
  });

  it('keeps Sessions and source resources isolated', async () => {
    const { manager, files } = createManager();
    const sessionAFile = await manager.ensureWritableResource(
      resourceRequest('session-a', 'file-1'),
    );
    const sessionBFile = await manager.ensureWritableResource(
      resourceRequest('session-b', 'file-1'),
    );
    const sessionAOtherFile = await manager.ensureWritableResource(
      resourceRequest('session-a', 'file-2', '/source/two.xlsx'),
    );

    files.set(sessionAFile.workingPath, 'A changed');

    expect(sessionAFile.workingPath).not.toBe(sessionBFile.workingPath);
    expect(sessionAFile.workingPath).not.toBe(sessionAOtherFile.workingPath);
    expect(files.get(sessionBFile.workingPath)).toBe('source workbook');
    expect(files.get(sessionAOtherFile.workingPath)).toBe('source workbook');
  });

  it('increments and persists revision only when marked modified', async () => {
    const { manager, store } = createManager();
    const request = resourceRequest('session-a', 'file-1');

    const created = await manager.ensureWritableResource(request);
    expect(created.revision).toBe(0);
    const first = await manager.markModified(request);
    const second = await manager.markModified(request);

    expect(first.revision).toBe(1);
    expect(second.revision).toBe(2);
    expect(store.saved.map((resource) => resource.revision)).toEqual([0, 1, 2]);
  });

  it('rejects a source identity mismatch and reports modification without a copy', async () => {
    const { manager } = createManager();
    const request = resourceRequest('session-a', 'file-1');
    await manager.ensureWritableResource(request);

    const mismatched = resourceRequest('session-a', 'file-1', '/source/other.xlsx');
    await expect(manager.resolveReadablePath(mismatched)).rejects.toBeInstanceOf(
      ExcelWorkingResourceSourceMismatchError,
    );
    await expect(manager.ensureWritableResource(mismatched)).rejects.toBeInstanceOf(
      ExcelWorkingResourceSourceMismatchError,
    );
    await expect(
      manager.markModified(resourceRequest('session-a', 'file-2')),
    ).rejects.toBeInstanceOf(ExcelWorkingResourceNotFoundError);
  });

  it('serializes concurrent first writable requests for one resource', async () => {
    const { manager, fileOperator } = createManager();
    const request = resourceRequest('session-a', 'file-1');

    const resources = await Promise.all([
      manager.ensureWritableResource(request),
      manager.ensureWritableResource(request),
      manager.ensureWritableResource(request),
    ]);

    expect(fileOperator.initializeCount).toBe(1);
    expect(new Set(resources.map((resource) => resource.workingPath))).toEqual(
      new Set(['/workspace/session-a/resources/file-1/working.xlsx']),
    );
    expect(new Set(resources.map((resource) => resource.revision))).toEqual(new Set([0]));
  });
});

class FakeStore implements ExcelWorkingResourceStore {
  private readonly resources = new Map<string, ExcelWorkingResource>();
  public readonly saved: ExcelWorkingResource[] = [];

  public async get(
    sessionId: string,
    sourceResourceId: string,
  ): Promise<ExcelWorkingResource | null> {
    return this.resources.get(key(sessionId, sourceResourceId)) ?? null;
  }

  public async save(resource: ExcelWorkingResource): Promise<void> {
    this.resources.set(key(resource.sessionId, resource.sourceResourceId), resource);
    this.saved.push(resource);
  }
}

class FakeFileOperator implements ExcelWorkingResourceFileOperator {
  public initializeCount = 0;
  public readonly files = new Map<string, string>([['/source/book.xlsx', 'source workbook']]);

  public constructor(private readonly publish: (resource: ExcelWorkingResource) => Promise<void>) {}

  public async initializeWorkingResource(
    input: ExcelWorkingResourceRequest,
  ): Promise<ExcelWorkingResource> {
    this.initializeCount += 1;
    const workingPath = `/workspace/${input.sessionId}/resources/${input.sourceResourceId}/working.xlsx`;
    await new Promise((resolve) => setTimeout(resolve, 1));
    this.files.set(workingPath, this.files.get(input.sourcePath) ?? 'source workbook');
    const resource: ExcelWorkingResource = {
      sessionId: input.sessionId,
      sourceResourceId: input.sourceResourceId,
      sourcePath: input.sourcePath,
      workingPath,
      revision: 0,
    };
    await this.publish(resource);
    return resource;
  }
}

function createManager(): {
  readonly manager: ExcelWorkingResourceManager;
  readonly store: FakeStore;
  readonly fileOperator: FakeFileOperator;
  readonly files: Map<string, string>;
} {
  const store = new FakeStore();
  const fileOperator = new FakeFileOperator((resource) => store.save(resource));
  return {
    manager: new ExcelWorkingResourceManager({ store, fileOperator }),
    store,
    fileOperator,
    files: fileOperator.files,
  };
}

function resourceRequest(
  sessionId: string,
  sourceResourceId: string,
  sourcePath = '/source/book.xlsx',
): ExcelWorkingResourceRequest {
  return { sessionId, sourceResourceId, sourcePath };
}

function key(sessionId: string, sourceResourceId: string): string {
  return `${sessionId}\u0000${sourceResourceId}`;
}
