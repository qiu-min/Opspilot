import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ExcelWorkingResourceManager,
  ExcelWorkingResourceSourceMismatchError,
  type ExcelWorkingMutationRequest,
  type ExcelWorkingResourceRequest,
} from '@opspilot/application';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ExcelWorkingResourceStoreError,
  FileSystemExcelWorkingResourceStore,
  MAX_EXCEL_WORKING_RESOURCE_MUTATION_RECEIPTS,
} from '../src/index.js';

const directories: string[] = [];

describe('FileSystemExcelWorkingResourceStore', () => {
  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it('keeps the source immutable and resolves only a committed revision after the first write', async () => {
    const fixture = await createFixture();
    const request = resourceRequest('session-a', 'file-1', fixture.sourcePath);

    await expect(fixture.manager.resolveReadablePath(request)).resolves.toBe(fixture.sourcePath);
    const first = await writeMutation(fixture.manager, request, 'call-1', 'revision one');
    const manifestPath = resourcePath(fixture.workspaceRoot, 'session-a', 'file-1', 'current.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;

    expect(first.resource.revision).toBe(1);
    expect(first.resource.workingPath).toContain(join('revisions', 'revision-1-'));
    expect(manifest).toMatchObject({
      version: 2,
      sessionId: 'session-a',
      sourceResourceId: 'file-1',
      sourcePath: fixture.sourcePath,
      revision: 1,
      file: expect.stringMatching(/^revisions\/revision-1-[a-f0-9-]+\.xlsx$/u),
      committedMutations: [
        { mutationId: 'call-1', revision: 1, receipt: { value: 'revision one' } },
      ],
    });
    expect(await fixture.manager.resolveReadablePath(request)).toBe(first.resource.workingPath);
    await expect(readFile(first.resource.workingPath, 'utf8')).resolves.toBe('revision one');
    await expect(readFile(fixture.sourcePath, 'utf8')).resolves.toBe('source workbook');
  });

  it('does not publish callback failures or leave a staging workbook', async () => {
    const fixture = await createFixture();
    const request = resourceRequest('session-a', 'file-1', fixture.sourcePath);
    await writeMutation(fixture.manager, request, 'call-1', 'revision one');
    const oldPath = await fixture.manager.resolveReadablePath(request);

    await expect(
      fixture.manager.executeMutation(
        mutationRequest(request, 'call-fail'),
        async ({ stagingPath }) => {
          await writeFile(stagingPath, 'partially written staging');
          throw new Error('Gateway failed after changing staging.');
        },
      ),
    ).rejects.toThrow('Gateway failed after changing staging.');

    expect(await fixture.manager.resolveReadablePath(request)).toBe(oldPath);
    expect((await fixture.store.get('session-a', 'file-1'))?.revision).toBe(1);
    await expect(readFile(oldPath, 'utf8')).resolves.toBe('revision one');
    await expect(readdir(resourcePath(fixture.workspaceRoot, 'session-a', 'file-1', 'staging')))
      .resolves.toEqual([]);
  });

  it('keeps the old pointer when candidate revision publication fails', async () => {
    const fixture = await createFixture(PublishFailureStore);
    const request = resourceRequest('session-a', 'file-1', fixture.sourcePath);
    await writeMutation(fixture.manager, request, 'call-1', 'revision one');
    const oldPath = await fixture.manager.resolveReadablePath(request);
    fixture.store.failPublication = true;

    await expect(writeMutation(fixture.manager, request, 'call-2', 'revision two')).rejects.toThrow(
      'candidate publish failure',
    );

    expect(await fixture.manager.resolveReadablePath(request)).toBe(oldPath);
    expect((await fixture.store.get('session-a', 'file-1'))?.revision).toBe(1);
    await expect(readFile(oldPath, 'utf8')).resolves.toBe('revision one');
  });

  it('treats a published candidate as orphan until current.json is atomically replaced', async () => {
    const fixture = await createFixture(PointerFailureStore);
    const request = resourceRequest('session-a', 'file-1', fixture.sourcePath);
    await writeMutation(fixture.manager, request, 'call-1', 'revision one');
    const oldPath = await fixture.manager.resolveReadablePath(request);
    fixture.store.failPointerReplacement = true;

    await expect(writeMutation(fixture.manager, request, 'call-2', 'revision two')).rejects.toThrow(
      'Unable to atomically commit Excel revision 2.',
    );

    expect(await fixture.manager.resolveReadablePath(request)).toBe(oldPath);
    expect((await fixture.store.get('session-a', 'file-1'))?.revision).toBe(1);
    const revisionsPath = resourcePath(fixture.workspaceRoot, 'session-a', 'file-1', 'revisions');
    const orphanName = (await readdir(revisionsPath)).find((name) => name.startsWith('revision-2-'));
    expect(orphanName).toBeDefined();

    await writeMutation(fixture.manager, request, 'call-3', 'revision three');
    expect(await readdir(revisionsPath)).not.toContain(orphanName);
    expect((await fixture.store.get('session-a', 'file-1'))?.revision).toBe(2);
  });

  it('replays the same mutationId without calling the writer or advancing revision', async () => {
    const fixture = await createFixture();
    const request = resourceRequest('session-a', 'file-1', fixture.sourcePath);
    let callbackCount = 0;
    const first = await fixture.manager.executeMutation(
      mutationRequest(request, 'call-1'),
      async ({ stagingPath }) => {
        callbackCount += 1;
        await writeFile(stagingPath, 'revision one');
        return { sheetName: 'Sales', range: 'D1:D2', message: 'Data written to Sales' };
      },
    );
    const replay = await fixture.manager.executeMutation(
      mutationRequest(request, 'call-1'),
      async () => {
        callbackCount += 1;
        return { sheetName: 'Wrong', range: 'A1', message: 'must not happen' };
      },
    );

    expect(callbackCount).toBe(1);
    expect(first).toMatchObject({ resource: { revision: 1 }, replayed: false });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(await fixture.store.getMutationReceipt('session-a', 'file-1', 'call-1')).toEqual({
      revision: 1,
      receipt: { sheetName: 'Sales', range: 'D1:D2', message: 'Data written to Sales' },
    });
  });

  it('commits different callIds as consecutive revisions and retains a bounded file window', async () => {
    const fixture = await createFixture();
    const request = resourceRequest('session-a', 'file-1', fixture.sourcePath);
    let lastResult;

    for (let revision = 0; revision <= MAX_EXCEL_WORKING_RESOURCE_MUTATION_RECEIPTS; revision += 1) {
      lastResult = await writeMutation(
        fixture.manager,
        request,
        `call-${revision}`,
        `revision ${revision}`,
      );
    }

    expect(lastResult?.resource.revision).toBe(MAX_EXCEL_WORKING_RESOURCE_MUTATION_RECEIPTS + 1);
    const revisions = await readdir(resourcePath(fixture.workspaceRoot, 'session-a', 'file-1', 'revisions'));
    expect(revisions.filter((name) => name.endsWith('.xlsx'))).toHaveLength(2);
    const manifest = JSON.parse(
      await readFile(resourcePath(fixture.workspaceRoot, 'session-a', 'file-1', 'current.json'), 'utf8'),
    ) as { readonly committedMutations: readonly unknown[] };
    expect(manifest.committedMutations).toHaveLength(MAX_EXCEL_WORKING_RESOURCE_MUTATION_RECEIPTS);
    expect(await fixture.store.getMutationReceipt('session-a', 'file-1', 'call-0')).toBeNull();
    expect(
      await fixture.store.getMutationReceipt(
        'session-a',
        'file-1',
        `call-${MAX_EXCEL_WORKING_RESOURCE_MUTATION_RECEIPTS}`,
      ),
    ).not.toBeNull();
  });

  it('serves the old committed path while a new mutation is still staging', async () => {
    const fixture = await createFixture();
    const request = resourceRequest('session-a', 'file-1', fixture.sourcePath);
    await writeMutation(fixture.manager, request, 'call-1', 'revision one');
    const oldPath = await fixture.manager.resolveReadablePath(request);
    const stagingStarted = deferred();
    const releaseStaging = deferred();

    const pending = fixture.manager.executeMutation(
      mutationRequest(request, 'call-2'),
      async ({ stagingPath }) => {
        await writeFile(stagingPath, 'revision two');
        stagingStarted.resolve();
        await releaseStaging.promise;
        return { value: 'revision two' };
      },
    );
    await stagingStarted.promise;
    expect(await fixture.manager.resolveReadablePath(request)).toBe(oldPath);
    await expect(readFile(oldPath, 'utf8')).resolves.toBe('revision one');
    releaseStaging.resolve();
    await pending;
    expect(await fixture.manager.resolveReadablePath(request)).not.toBe(oldPath);
  });

  it('serializes same-resource mutations through callback and pointer commit', async () => {
    const fixture = await createFixture();
    const request = resourceRequest('session-a', 'file-1', fixture.sourcePath);
    const firstStarted = deferred();
    const releaseFirst = deferred();
    let secondStarted = false;
    const first = fixture.manager.executeMutation(
      mutationRequest(request, 'call-1'),
      async ({ stagingPath }) => {
        await writeFile(stagingPath, 'revision one');
        firstStarted.resolve();
        await releaseFirst.promise;
        return { value: 'one' };
      },
    );
    await firstStarted.promise;
    const second = fixture.manager.executeMutation(
      mutationRequest(request, 'call-2'),
      async ({ stagingPath, baseRevision }) => {
        secondStarted = true;
        expect(baseRevision).toBe(1);
        await writeFile(stagingPath, 'revision two');
        return { value: 'two' };
      },
    );
    await Promise.resolve();
    expect(secondStarted).toBe(false);
    releaseFirst.resolve();
    const results = await Promise.all([first, second]);
    expect(results.map((result) => result.resource.revision)).toEqual([1, 2]);
  });

  it('lazily migrates legacy working.xlsx conservatively, including revision zero edits', async () => {
    const fixture = await createFixture();
    const request = resourceRequest('session-a', 'file-1', fixture.sourcePath);
    const directory = resourcePath(fixture.workspaceRoot, 'session-a', 'file-1');
    const legacyWorking = join(directory, 'working.xlsx');
    await mkdir(directory, { recursive: true });
    await writeFile(legacyWorking, 'legacy user changes', 'utf8');
    await writeFile(
      join(directory, 'metadata.json'),
      JSON.stringify({
        version: 1,
        sessionId: request.sessionId,
        sourceResourceId: request.sourceResourceId,
        sourcePath: request.sourcePath,
        workingPath: legacyWorking,
        revision: 0,
      }),
      'utf8',
    );

    const migratedPath = await fixture.manager.resolveReadablePath(request);
    const migrated = await fixture.store.get('session-a', 'file-1');
    expect(migrated).toMatchObject({ revision: 0, sourcePath: fixture.sourcePath, workingPath: migratedPath });
    await expect(readFile(migratedPath, 'utf8')).resolves.toBe('legacy user changes');
    expect(migratedPath).toContain(join('revisions', 'revision-0-'));

    const next = await writeMutation(fixture.manager, request, 'call-after-legacy', 'revision one');
    expect(next.resource.revision).toBe(1);
    await expect(readFile(fixture.sourcePath, 'utf8')).resolves.toBe('source workbook');
  });

  it('fails fast if current.json references a missing or unsafe revision file', async () => {
    const fixture = await createFixture();
    const request = resourceRequest('session-a', 'file-1', fixture.sourcePath);
    const first = await writeMutation(fixture.manager, request, 'call-1', 'revision one');
    const currentPath = resourcePath(fixture.workspaceRoot, 'session-a', 'file-1', 'current.json');
    const manifest = JSON.parse(await readFile(currentPath, 'utf8')) as Record<string, unknown>;

    await rm(first.resource.workingPath);
    await expect(fixture.manager.resolveReadablePath(request)).rejects.toThrow(/does not exist/);
    manifest.file = '../outside.xlsx';
    await writeFile(currentPath, JSON.stringify(manifest), 'utf8');
    await expect(fixture.manager.resolveReadablePath(request)).rejects.toThrow(ExcelWorkingResourceStoreError);
  });

  it('rejects a changed source identity', async () => {
    const fixture = await createFixture();
    const request = resourceRequest('session-a', 'file-1', fixture.sourcePath);
    await writeMutation(fixture.manager, request, 'call-1', 'revision one');

    await expect(
      fixture.manager.resolveReadablePath({ ...request, sourcePath: join(fixture.root, 'other.xlsx') }),
    ).rejects.toBeInstanceOf(ExcelWorkingResourceSourceMismatchError);
  });
});

class PublishFailureStore extends FileSystemExcelWorkingResourceStore {
  public failPublication = false;

  protected override async publishRevision(stagingPath: string, candidatePath: string): Promise<void> {
    if (this.failPublication) {
      this.failPublication = false;
      throw new Error('candidate publish failure');
    }
    await super.publishRevision(stagingPath, candidatePath);
  }
}

class PointerFailureStore extends FileSystemExcelWorkingResourceStore {
  public failPointerReplacement = false;

  protected override async replaceCurrentPointer(
    temporaryPath: string,
    currentPath: string,
  ): Promise<void> {
    if (this.failPointerReplacement) {
      this.failPointerReplacement = false;
      throw new Error('pointer replacement failure');
    }
    await super.replaceCurrentPointer(temporaryPath, currentPath);
  }
}

async function createFixture<TStore extends FileSystemExcelWorkingResourceStore>(
  StoreType: new (workspaceRoot: string) => TStore = FileSystemExcelWorkingResourceStore as new (
    workspaceRoot: string,
  ) => TStore,
): Promise<{
  readonly root: string;
  readonly sourcePath: string;
  readonly workspaceRoot: string;
  readonly store: TStore;
  readonly manager: ExcelWorkingResourceManager;
}> {
  const root = await mkdtemp(join(tmpdir(), 'opspilot-excel-working-resource-'));
  directories.push(root);
  const sourcePath = join(root, 'source.xlsx');
  const workspaceRoot = join(root, 'workspaces');
  await writeFile(sourcePath, 'source workbook', 'utf8');
  const store = new StoreType(workspaceRoot);
  return {
    root,
    sourcePath,
    workspaceRoot,
    store,
    manager: new ExcelWorkingResourceManager({ store, fileOperator: store }),
  };
}

async function writeMutation(
  manager: ExcelWorkingResourceManager,
  request: ExcelWorkingResourceRequest,
  mutationId: string,
  content: string,
) {
  return await manager.executeMutation(mutationRequest(request, mutationId), async ({ stagingPath }) => {
    await writeFile(stagingPath, content, 'utf8');
    return { value: content };
  });
}

function resourceRequest(
  sessionId: string,
  sourceResourceId: string,
  sourcePath: string,
): ExcelWorkingResourceRequest {
  return { sessionId, sourceResourceId, sourcePath };
}

function mutationRequest(
  request: ExcelWorkingResourceRequest,
  mutationId: string,
): ExcelWorkingMutationRequest {
  return { ...request, mutationId };
}

function resourcePath(
  workspaceRoot: string,
  sessionId: string,
  sourceResourceId: string,
  ...segments: string[]
): string {
  return join(workspaceRoot, sessionId, 'resources', sourceResourceId, ...segments);
}

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
