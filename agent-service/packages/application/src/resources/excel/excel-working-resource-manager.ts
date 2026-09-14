import type {
  ExcelWorkingResource,
  ExcelWorkingResourceRequest,
} from './excel-working-resource.js';
import type { ExcelWorkingResourceFileOperator } from './excel-working-resource-file-operator.js';
import {
  ExcelWorkingResourceError,
  ExcelWorkingResourceNotFoundError,
  ExcelWorkingResourceSourceMismatchError,
} from './excel-working-resource-errors.js';
import type { ExcelWorkingResourceStore } from './excel-working-resource-store.js';

/** Dependencies for the Session-scoped Excel copy-on-write coordinator. */
export interface ExcelWorkingResourceManagerDependencies {
  readonly store: ExcelWorkingResourceStore;
  readonly fileOperator: ExcelWorkingResourceFileOperator;
}

/** Resolves readable paths and creates or advances Session-owned Excel working copies. */
export class ExcelWorkingResourceManager {
  private readonly store: ExcelWorkingResourceStore;
  private readonly fileOperator: ExcelWorkingResourceFileOperator;
  private readonly locks = new Map<string, Promise<void>>();

  public constructor(options: ExcelWorkingResourceManagerDependencies) {
    this.store = options.store;
    this.fileOperator = options.fileOperator;
  }

  /** Returns the working path when a copy exists, otherwise the immutable source path. */
  public async resolveReadablePath(input: ExcelWorkingResourceRequest): Promise<string> {
    this.assertRequest(input);
    return await this.withResourceLock(input, async () => {
      const resource = await this.loadExistingResource(input);
      return resource?.workingPath ?? input.sourcePath;
    });
  }

  /** Creates the first working copy for a resource, or returns the existing copy unchanged. */
  public async ensureWritableResource(
    input: ExcelWorkingResourceRequest,
  ): Promise<ExcelWorkingResource> {
    this.assertRequest(input);
    return await this.withResourceLock(input, async () => {
      const existing = await this.loadExistingResource(input);
      if (existing !== null) return existing;

      const workingPath = this.fileOperator.getWorkingPath(input.sessionId, input.sourceResourceId);
      if (workingPath.trim().length === 0) {
        throw new ExcelWorkingResourceError(
          'Working resource file operator returned an empty path.',
        );
      }

      const resource: ExcelWorkingResource = {
        sessionId: input.sessionId,
        sourceResourceId: input.sourceResourceId,
        sourcePath: input.sourcePath,
        workingPath,
        revision: 0,
      };

      // The copy is created before metadata is published. A later ensure call can
      // therefore never copy the immutable source over an already-created resource.
      await this.fileOperator.copySourceToWorking(input.sourcePath, workingPath, input.signal);
      await this.store.save(resource, input.signal);
      return resource;
    });
  }

  /** Advances the durable working-copy revision after a successful user mutation. */
  public async markModified(input: ExcelWorkingResourceRequest): Promise<ExcelWorkingResource> {
    this.assertRequest(input);
    return await this.withResourceLock(input, async () => {
      const existing = await this.loadExistingResource(input);
      if (existing === null) {
        throw new ExcelWorkingResourceNotFoundError(input.sessionId, input.sourceResourceId);
      }
      if (existing.revision === Number.MAX_SAFE_INTEGER) {
        throw new ExcelWorkingResourceError(
          `Excel working resource revision cannot advance beyond ${Number.MAX_SAFE_INTEGER}.`,
        );
      }

      const updated: ExcelWorkingResource = {
        ...existing,
        revision: existing.revision + 1,
      };
      await this.store.save(updated, input.signal);
      return updated;
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
