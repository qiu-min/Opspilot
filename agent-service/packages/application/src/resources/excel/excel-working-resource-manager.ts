import type {
  ExcelWorkingMutationContext,
  ExcelWorkingMutationRequest,
  ExcelWorkingMutationResult,
  ExcelWorkingResource,
  ExcelWorkingResourceRequest,
} from './excel-working-resource.js';
import type { ExcelWorkingResourceFileOperator } from './excel-working-resource-file-operator.js';
import {
  ExcelWorkingResourceError,
  ExcelWorkingResourceSourceMismatchError,
} from './excel-working-resource-errors.js';
import type { ExcelWorkingResourceStore } from './excel-working-resource-store.js';

/** Dependencies for the Session-scoped Excel working-resource coordinator. */
export interface ExcelWorkingResourceManagerDependencies {
  readonly store: ExcelWorkingResourceStore;
  readonly fileOperator: ExcelWorkingResourceFileOperator;
}

/** Coordinates committed reads and atomic, idempotent Session-scoped workbook mutations. */
export class ExcelWorkingResourceManager {
  private readonly store: ExcelWorkingResourceStore;
  private readonly fileOperator: ExcelWorkingResourceFileOperator;
  private readonly locks = new Map<string, Promise<void>>();

  public constructor(options: ExcelWorkingResourceManagerDependencies) {
    this.store = options.store;
    this.fileOperator = options.fileOperator;
  }

  /** Returns only the source or the file currently referenced by durable committed state. */
  public async resolveReadablePath(input: ExcelWorkingResourceRequest): Promise<string> {
    this.assertRequest(input);
    throwIfAborted(input.signal);
    const resource = await this.loadExistingResource(input);
    throwIfAborted(input.signal);
    return resource?.workingPath ?? input.sourcePath;
  }

  /**
   * Serializes the complete staged mutation lifecycle and replays an existing durable receipt
   * without invoking the mutation callback again.
   */
  public async executeMutation(
    input: ExcelWorkingMutationRequest,
    mutate: (context: ExcelWorkingMutationContext) => Promise<unknown>,
  ): Promise<ExcelWorkingMutationResult> {
    this.assertMutationRequest(input);
    return await this.withResourceLock(input, async () => {
      throwIfAborted(input.signal);
      const existing = await this.loadExistingResource(input);
      const committed = await this.store.getMutationReceipt(
        input.sessionId,
        input.sourceResourceId,
        input.mutationId,
        input.signal,
      );
      if (committed !== null) {
        if (existing === null) {
          throw new ExcelWorkingResourceError(
            'A committed mutation receipt exists without a current working resource.',
          );
        }
        return { resource: existing, receipt: committed.receipt, replayed: true };
      }

      const context = await this.fileOperator.prepareMutation(input);
      this.assertMutationContext(context);
      try {
        const receipt = await mutate(context);
        throwIfAborted(input.signal);
        assertJsonSerializableReceipt(receipt);

        // Once finalization starts, do not pass the caller's signal into the commit operation.
        const { signal: _signal, ...commitInput } = input;
        const resource = await this.fileOperator.commitMutation(commitInput, context, receipt);
        this.assertCommittedResource(input, resource, context);
        return { resource, receipt, replayed: false };
      } catch (error) {
        const { signal: _signal, ...abortInput } = input;
        try {
          await this.fileOperator.abortMutation(abortInput, context);
        } catch {
          // An orphan staging file is safe; later mutation access reconciles it.
        }
        throw error;
      }
    });
  }

  private async loadExistingResource(
    input: ExcelWorkingResourceRequest,
  ): Promise<ExcelWorkingResource | null> {
    const resource = await this.store.get(input.sessionId, input.sourceResourceId, input.signal);
    if (resource === null) return null;
    if (resource.sourcePath !== input.sourcePath) {
      throw new ExcelWorkingResourceSourceMismatchError(
        input.sessionId,
        input.sourceResourceId,
        resource.sourcePath,
        input.sourcePath,
      );
    }
    return resource;
  }

  private assertRequest(input: ExcelWorkingResourceRequest): void {
    if (typeof input.sessionId !== 'string' || input.sessionId.trim().length === 0) {
      throw new ExcelWorkingResourceError('sessionId is required.');
    }
    if (typeof input.sourceResourceId !== 'string' || input.sourceResourceId.trim().length === 0) {
      throw new ExcelWorkingResourceError('sourceResourceId is required.');
    }
    if (typeof input.sourcePath !== 'string' || input.sourcePath.trim().length === 0) {
      throw new ExcelWorkingResourceError('sourcePath is required.');
    }
  }

  private assertMutationRequest(input: ExcelWorkingMutationRequest): void {
    this.assertRequest(input);
    if (typeof input.mutationId !== 'string' || input.mutationId.trim().length === 0) {
      throw new ExcelWorkingResourceError('mutationId is required.');
    }
  }

  private assertMutationContext(context: ExcelWorkingMutationContext): void {
    if (
      typeof context.stagingPath !== 'string' ||
      context.stagingPath.trim().length === 0 ||
      !Number.isSafeInteger(context.baseRevision) ||
      context.baseRevision < 0 ||
      !Number.isSafeInteger(context.targetRevision) ||
      context.targetRevision !== context.baseRevision + 1
    ) {
      throw new ExcelWorkingResourceError('Mutation preparer returned an invalid staging context.');
    }
  }

  private assertCommittedResource(
    input: ExcelWorkingMutationRequest,
    resource: ExcelWorkingResource,
    context: ExcelWorkingMutationContext,
  ): void {
    if (
      resource.sessionId !== input.sessionId ||
      resource.sourceResourceId !== input.sourceResourceId ||
      resource.sourcePath !== input.sourcePath ||
      resource.revision !== context.targetRevision ||
      resource.workingPath.trim().length === 0
    ) {
      throw new ExcelWorkingResourceError(
        'Mutation committer returned a resource that does not match the committed mutation.',
      );
    }
  }

  private async withResourceLock<T>(
    input: ExcelWorkingResourceRequest,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = `${input.sessionId}\u0000${input.sourceResourceId}`;
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(key, current);

    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(key) === current) this.locks.delete(key);
    }
  }
}

/** Rejects callback results that cannot be stored and replayed as durable JSON. */
function assertJsonSerializableReceipt(value: unknown): void {
  const visited = new Set<object>();

  const visit = (candidate: unknown): void => {
    if (
      candidate === null ||
      typeof candidate === 'string' ||
      typeof candidate === 'boolean' ||
      (typeof candidate === 'number' && Number.isFinite(candidate))
    ) {
      return;
    }
    if (typeof candidate !== 'object' || visited.has(candidate)) {
      throw new ExcelWorkingResourceError('Mutation receipt must be a JSON-serializable value.');
    }
    visited.add(candidate);
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      visited.delete(candidate);
      return;
    }
    const prototype = Object.getPrototypeOf(candidate) as unknown;
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(candidate).length > 0
    ) {
      throw new ExcelWorkingResourceError('Mutation receipt must be a JSON-serializable value.');
    }
    for (const item of Object.values(candidate as Record<string, unknown>)) visit(item);
    visited.delete(candidate);
  };

  visit(value);
  try {
    JSON.stringify(value);
  } catch (error) {
    throw new ExcelWorkingResourceError('Mutation receipt must be a JSON-serializable value.', {
      cause: error,
    });
  }
}

/** Throws the original cancellation reason before the resource commit point. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new Error('Excel mutation was aborted.');
}
