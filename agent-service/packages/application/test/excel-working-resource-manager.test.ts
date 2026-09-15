import { describe, expect, it } from 'vitest';

import {
  ExcelWorkingResourceManager,
  ExcelWorkingResourceSourceMismatchError,
  type ExcelWorkingMutationContext,
  type ExcelWorkingMutationReceiptRecord,
  type ExcelWorkingMutationRequest,
  type ExcelWorkingResource,
  type ExcelWorkingResourceFileOperator,
  type ExcelWorkingResourceRequest,
  type ExcelWorkingResourceStore,
} from '../src/index.js';

const firstReceipt = { range: 'A1:A1', message: 'written' };

describe('ExcelWorkingResourceManager', () => {
  it('reads the immutable source before the first successful mutation', async () => {
    const { manager, fileOperator } = createManager();
    const request = resourceRequest('session-a', 'file-1');

    await expect(manager.resolveReadablePath(request)).resolves.toBe(request.sourcePath);
    expect(fileOperator.prepareCount).toBe(0);
  });

  it('commits the first mutation as revision 1 without exposing its staging path', async () => {
    const { manager, store } = createManager();
    const request = mutationRequest('session-a', 'file-1', 'call-1');
    let stagingPath = '';

    const result = await manager.executeMutation(request, async (context) => {
      stagingPath = context.stagingPath;
      expect(await manager.resolveReadablePath(request)).toBe(request.sourcePath);
      return firstReceipt;
    });

    expect(result).toMatchObject({
      resource: { revision: 1, sourcePath: request.sourcePath },
      receipt: firstReceipt,
      replayed: false,
    });
    expect(result.resource.workingPath).not.toBe(stagingPath);
    expect(await store.get('session-a', 'file-1')).toEqual(result.resource);
    expect(await manager.resolveReadablePath(request)).toBe(result.resource.workingPath);
  });

  it('replays a durable receipt for the same mutationId and commits a new id as the next revision', async () => {
    const { manager, fileOperator } = createManager();
    const request = mutationRequest('session-a', 'file-1', 'call-1');
    let callbackCount = 0;

    const first = await manager.executeMutation(request, async () => {
      callbackCount += 1;
      return firstReceipt;
    });
    const replay = await manager.executeMutation(request, async () => {
      callbackCount += 1;
      return { range: 'wrong', message: 'must not run' };
    });
    const next = await manager.executeMutation(
      mutationRequest('session-a', 'file-1', 'call-2'),
      async (context) => {
        callbackCount += 1;
        expect(context.baseRevision).toBe(1);
        expect(context.targetRevision).toBe(2);
        return { range: 'B1:B1', message: 'next' };
      },
    );

    expect(callbackCount).toBe(2);
    expect(fileOperator.prepareCount).toBe(2);
    expect(replay).toMatchObject({ resource: { revision: 1 }, receipt: firstReceipt, replayed: true });
    expect(next).toMatchObject({ resource: { revision: 2 }, replayed: false });
    expect(await manager.resolveReadablePath(request)).toBe(next.resource.workingPath);
    expect(first.resource.revision).toBe(1);
  });

  it('aborts a failed or cancelled staging callback without publishing a revision', async () => {
    const { manager, store, fileOperator } = createManager();
    const request = mutationRequest('session-a', 'file-1', 'call-failed');
    await expect(
      manager.executeMutation(request, async () => {
        throw new Error('staging write failed');
      }),
    ).rejects.toThrow('staging write failed');
    expect(fileOperator.abortCount).toBe(1);
    expect(await store.get('session-a', 'file-1')).toBeNull();

    const controller = new AbortController();
    const cancelledRequest = { ...mutationRequest('session-a', 'file-2', 'call-cancelled'), signal: controller.signal };
    const abortReason = new Error('cancelled before commit');
    await expect(
      manager.executeMutation(cancelledRequest, async () => {
        controller.abort(abortReason);
        return firstReceipt;
      }),
    ).rejects.toBe(abortReason);
    expect(await store.get('session-a', 'file-2')).toBeNull();
    expect(fileOperator.abortCount).toBe(2);
  });

  it('rejects a changed source path for an existing resource', async () => {
    const { manager } = createManager();
    const request = mutationRequest('session-a', 'file-1', 'call-1');
    await manager.executeMutation(request, async () => firstReceipt);

    await expect(
      manager.executeMutation(
        { ...request, sourcePath: '/source/changed.xlsx', mutationId: 'call-2' },
        async () => firstReceipt,
      ),
    ).rejects.toBeInstanceOf(ExcelWorkingResourceSourceMismatchError);
  });

  it('holds the per-resource lock through callback and commit, advancing concurrent revisions strictly', async () => {
    const { manager } = createManager();
    const requestA = mutationRequest('session-a', 'file-1', 'call-a');
    const requestB = mutationRequest('session-a', 'file-1', 'call-b');
    const callbackAStarted = deferred();
    const releaseA = deferred();
    let callbackBStarted = false;

    const first = manager.executeMutation(requestA, async () => {
      callbackAStarted.resolve();
      await releaseA.promise;
      return { range: 'A1', message: 'first' };
    });
    await callbackAStarted.promise;
    const second = manager.executeMutation(requestB, async (context) => {
      callbackBStarted = true;
      expect(context.baseRevision).toBe(1);
      return { range: 'B1', message: 'second' };
    });
    await Promise.resolve();
    expect(callbackBStarted).toBe(false);
    releaseA.resolve();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect([firstResult.resource.revision, secondResult.resource.revision]).toEqual([1, 2]);
  });

  it('allows different resources to mutate concurrently', async () => {
    const { manager } = createManager();
    const bothStarted = deferred();
    const release = deferred();
    let startedCount = 0;
    const callback = async () => {
      startedCount += 1;
      if (startedCount === 2) bothStarted.resolve();
      await release.promise;
      return firstReceipt;
    };

    const first = manager.executeMutation(
      mutationRequest('session-a', 'file-1', 'call-1'),
      callback,
    );
    const second = manager.executeMutation(
      mutationRequest('session-a', 'file-2', 'call-2'),
      callback,
    );
    await bothStarted.promise;
    release.resolve();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it('rejects non-JSON receipts before commit and aborts the staged file', async () => {
    const { manager, fileOperator, store } = createManager();
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;

    await expect(
      manager.executeMutation(mutationRequest('session-a', 'file-1', 'call-1'), async () => cycle),
    ).rejects.toThrow('JSON-serializable');
    expect(fileOperator.abortCount).toBe(1);
    expect(await store.get('session-a', 'file-1')).toBeNull();
  });
});

class FakeStore implements ExcelWorkingResourceStore {
  private readonly resources = new Map<string, ExcelWorkingResource>();
  private readonly receipts = new Map<string, ExcelWorkingMutationReceiptRecord>();

  public async get(
    sessionId: string,
    sourceResourceId: string,
  ): Promise<ExcelWorkingResource | null> {
    return this.resources.get(key(sessionId, sourceResourceId)) ?? null;
  }

  public async getMutationReceipt(
    sessionId: string,
    sourceResourceId: string,
    mutationId: string,
  ): Promise<ExcelWorkingMutationReceiptRecord | null> {
    return this.receipts.get(`${key(sessionId, sourceResourceId)}\u0000${mutationId}`) ?? null;
  }

  public commit(request: ExcelWorkingMutationRequest, resource: ExcelWorkingResource, receipt: unknown): void {
    this.resources.set(key(request.sessionId, request.sourceResourceId), resource);
    this.receipts.set(`${key(request.sessionId, request.sourceResourceId)}\u0000${request.mutationId}`, {
      revision: resource.revision,
      receipt,
    });
  }
}

class FakeFileOperator implements ExcelWorkingResourceFileOperator {
  public prepareCount = 0;
  public abortCount = 0;

  public constructor(private readonly store: FakeStore) {}

  public async prepareMutation(
    input: ExcelWorkingMutationRequest,
  ): Promise<ExcelWorkingMutationContext> {
    this.prepareCount += 1;
    const existing = await this.store.get(input.sessionId, input.sourceResourceId);
    const baseRevision = existing?.revision ?? 0;
    return {
      stagingPath: `/workspace/${input.sessionId}/resources/${input.sourceResourceId}/staging/mutation-${this.prepareCount}.xlsx`,
      baseRevision,
      targetRevision: baseRevision + 1,
    };
  }

  public async commitMutation(
    input: ExcelWorkingMutationRequest,
    context: ExcelWorkingMutationContext,
    receipt: unknown,
  ): Promise<ExcelWorkingResource> {
    const resource: ExcelWorkingResource = {
      sessionId: input.sessionId,
      sourceResourceId: input.sourceResourceId,
      sourcePath: input.sourcePath,
      workingPath: `/workspace/${input.sessionId}/resources/${input.sourceResourceId}/revisions/revision-${context.targetRevision}.xlsx`,
      revision: context.targetRevision,
    };
    this.store.commit(input, resource, receipt);
    return resource;
  }

  public async abortMutation(): Promise<void> {
    this.abortCount += 1;
  }
}

function createManager(): {
  readonly manager: ExcelWorkingResourceManager;
  readonly store: FakeStore;
  readonly fileOperator: FakeFileOperator;
} {
  const store = new FakeStore();
  const fileOperator = new FakeFileOperator(store);
  return { manager: new ExcelWorkingResourceManager({ store, fileOperator }), store, fileOperator };
}

function resourceRequest(
  sessionId: string,
  sourceResourceId: string,
  sourcePath = '/source/book.xlsx',
): ExcelWorkingResourceRequest {
  return { sessionId, sourceResourceId, sourcePath };
}

function mutationRequest(
  sessionId: string,
  sourceResourceId: string,
  mutationId: string,
  sourcePath = '/source/book.xlsx',
): ExcelWorkingMutationRequest {
  return { ...resourceRequest(sessionId, sourceResourceId, sourcePath), mutationId };
}

function key(sessionId: string, sourceResourceId: string): string {
  return `${sessionId}\u0000${sourceResourceId}`;
}

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
