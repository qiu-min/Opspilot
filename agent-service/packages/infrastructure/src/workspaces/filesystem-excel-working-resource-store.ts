import { constants as fsConstants } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import type {
  ExcelWorkingResource,
  ExcelWorkingResourceFileOperator,
  ExcelWorkingResourceStore,
} from '@opspilot/application';

/** Current version of the working-resource metadata document. */
export const CURRENT_EXCEL_WORKING_RESOURCE_METADATA_VERSION = 1 as const;
const resourceIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;

/** Raised when an Excel working-resource filesystem layout is invalid or unavailable. */
export class ExcelWorkingResourceStoreError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ExcelWorkingResourceStoreError';
  }
}

/** JSON representation stored beside one Session/resource working copy. */
export interface ExcelWorkingResourceMetadataRecord {
  readonly version: typeof CURRENT_EXCEL_WORKING_RESOURCE_METADATA_VERSION;
  readonly sessionId: string;
  readonly sourceResourceId: string;
  readonly sourcePath: string;
  readonly workingPath: string;
  readonly revision: number;
}

interface WorkingResourcePaths {
  readonly directory: string;
  readonly working: string;
  readonly metadata: string;
}

/**
 * Persists Session-scoped Excel working resources below one workspace root.
 * The same adapter also provides the copy operation used by the Application manager.
 */
export class FileSystemExcelWorkingResourceStore
  implements ExcelWorkingResourceStore, ExcelWorkingResourceFileOperator
{
  private readonly workspaceRoot: string;

  public constructor(workspaceRoot: string) {
    if (typeof workspaceRoot !== 'string' || workspaceRoot.trim().length === 0) {
      throw new ExcelWorkingResourceStoreError('workspaceRoot is required.');
    }
    this.workspaceRoot = resolve(workspaceRoot);
  }

  /** Loads one resource metadata document, returning null when it has not been published. */
  public async get(
    sessionId: string,
    sourceResourceId: string,
    signal?: AbortSignal,
  ): Promise<ExcelWorkingResource | null> {
    const paths = this.getPaths(sessionId, sourceResourceId);
    throwIfAborted(signal);

    if (!(await existsAsFile(paths.metadata, this.workspaceRoot))) return null;
    const resource = await this.readMetadata(paths.metadata, sessionId, sourceResourceId);
    await assertRegularFileInsideWorkspace(paths.working, this.workspaceRoot, 'working copy');
    throwIfAborted(signal);
    return resource;
  }

  /** Atomically saves a validated metadata snapshot and never moves revision backwards. */
  public async save(resource: ExcelWorkingResource, signal?: AbortSignal): Promise<void> {
    const paths = this.getPaths(resource.sessionId, resource.sourceResourceId);
    validateResource(resource, paths.working);
    throwIfAborted(signal);
    await ensureDirectoryInsideWorkspace(paths.directory, this.workspaceRoot);

    if (await existsAsFile(paths.metadata, this.workspaceRoot)) {
      const previous = await this.readMetadata(
        paths.metadata,
        resource.sessionId,
        resource.sourceResourceId,
      );
      if (previous.revision > resource.revision) {
        throw new ExcelWorkingResourceStoreError(
          `Excel working resource revision cannot move backwards for ` +
            `${resource.sessionId}/${resource.sourceResourceId}: ` +
            `${previous.revision} -> ${resource.revision}.`,
        );
      }
    }

    const temporaryPath = `${paths.metadata}.tmp-${randomUUID()}`;
    try {
      await writeFile(temporaryPath, serializeMetadata(resource), {
        encoding: 'utf8',
        flag: 'wx',
      });
      throwIfAborted(signal);
      await rename(temporaryPath, paths.metadata);
    } catch (error) {
      if (error instanceof ExcelWorkingResourceStoreError) throw error;
      throw new ExcelWorkingResourceStoreError(
        `Unable to atomically save Excel working resource metadata for ` +
          `${resource.sessionId}/${resource.sourceResourceId}.`,
        { cause: error },
      );
    } finally {
      await removeTemporaryFile(temporaryPath);
    }
  }

  /** Removes one resource directory without allowing an id to escape workspaceRoot. */
  public async delete(
    sessionId: string,
    sourceResourceId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const paths = this.getPaths(sessionId, sourceResourceId);
    throwIfAborted(signal);
    if (!(await existsAsPath(paths.directory))) return;
    await assertDirectoryInsideWorkspace(paths.directory, this.workspaceRoot);
    try {
      await rm(paths.directory, { recursive: true, force: true });
    } catch (error) {
      throw new ExcelWorkingResourceStoreError(
        `Unable to delete Excel working resource ${sessionId}/${sourceResourceId}.`,
        { cause: error },
      );
    }
  }

  /** Returns the deterministic working.xlsx path for one Session/resource identity. */
  public getWorkingPath(sessionId: string, sourceResourceId: string): string {
    return this.getPaths(sessionId, sourceResourceId).working;
  }

  /** Copies a source only into the expected workspace path, refusing to overwrite a copy. */
  public async copySourceToWorking(
    sourcePath: string,
    workingPath: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (typeof sourcePath !== 'string' || sourcePath.trim().length === 0) {
      throw new ExcelWorkingResourceStoreError('sourcePath is required.');
    }
    const expectedWorkingPath = this.getExpectedWorkingPath(workingPath);
    throwIfAborted(signal);
    await ensureDirectoryInsideWorkspace(dirname(expectedWorkingPath), this.workspaceRoot);

    try {
      await copyFile(sourcePath, expectedWorkingPath, fsConstants.COPYFILE_EXCL);
      throwIfAborted(signal);
    } catch (error) {
      if (error instanceof ExcelWorkingResourceStoreError) throw error;
      throw new ExcelWorkingResourceStoreError(
        `Unable to create Excel working copy at ${expectedWorkingPath}.`,
        { cause: error },
      );
    }
  }

  private async readMetadata(
    metadataPath: string,
    sessionId: string,
    sourceResourceId: string,
  ): Promise<ExcelWorkingResource> {
    try {
      await assertRegularFileInsideWorkspace(metadataPath, this.workspaceRoot, 'metadata');
      const content = await readFile(metadataPath, 'utf8');
      const resource = parseMetadata(content);
      if (resource.sessionId !== sessionId || resource.sourceResourceId !== sourceResourceId) {
        throw new ExcelWorkingResourceStoreError(
          `Excel working resource metadata identity does not match ${sessionId}/${sourceResourceId}.`,
        );
      }
      const expectedWorkingPath = this.getWorkingPath(sessionId, sourceResourceId);
      if (resolve(resource.workingPath) !== expectedWorkingPath) {
        throw new ExcelWorkingResourceStoreError(
          `Excel working resource metadata workingPath must remain within workspaceRoot and ` +
            `match the resource identity.`,
        );
      }
      return { ...resource, workingPath: expectedWorkingPath };
    } catch (error) {
      if (error instanceof ExcelWorkingResourceStoreError) throw error;
      throw new ExcelWorkingResourceStoreError(
        `Unable to read Excel working resource metadata for ${sessionId}/${sourceResourceId}.`,
        { cause: error },
      );
    }
  }

  private getPaths(sessionId: string, sourceResourceId: string): WorkingResourcePaths {
    assertSafeResourceId(sessionId, 'sessionId');
    assertSafeResourceId(sourceResourceId, 'sourceResourceId');
    const directory = join(this.workspaceRoot, sessionId, 'resources', sourceResourceId);
    return {
      directory,
      working: join(directory, 'working.xlsx'),
      metadata: join(directory, 'metadata.json'),
    };
  }

  private getExpectedWorkingPath(workingPath: string): string {
    if (typeof workingPath !== 'string' || workingPath.trim().length === 0) {
      throw new ExcelWorkingResourceStoreError('workingPath is required.');
    }
    const normalized = resolve(workingPath);
    if (
      !isPathWithin(this.workspaceRoot, normalized) ||
      !normalized.endsWith(`${sep}working.xlsx`)
    ) {
      throw new ExcelWorkingResourceStoreError(
        'workingPath must point to working.xlsx within workspaceRoot.',
      );
    }
    const relativePath = relative(this.workspaceRoot, normalized);
    const segments = relativePath.split(/[\\/]+/u);
    if (
      segments.length !== 4 ||
      segments[1] !== 'resources' ||
      segments[3] !== 'working.xlsx' ||
      !resourceIdPattern.test(segments[0] ?? '') ||
      !resourceIdPattern.test(segments[2] ?? '')
    ) {
      throw new ExcelWorkingResourceStoreError(
        'workingPath must match workspaceRoot/{sessionId}/resources/{sourceResourceId}/working.xlsx.',
      );
    }
    return normalized;
  }
}

function serializeMetadata(resource: ExcelWorkingResource): string {
  const record: ExcelWorkingResourceMetadataRecord = {
    version: CURRENT_EXCEL_WORKING_RESOURCE_METADATA_VERSION,
    sessionId: resource.sessionId,
    sourceResourceId: resource.sourceResourceId,
    sourcePath: resource.sourcePath,
    workingPath: resource.workingPath,
    revision: resource.revision,
  };
  return `${JSON.stringify(record, null, 2)}\n`;
}

function parseMetadata(content: string): ExcelWorkingResource {
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch (error) {
    throw new ExcelWorkingResourceStoreError(
      'Excel working resource metadata contains invalid JSON.',
      {
        cause: error,
      },
    );
  }
  if (!isRecord(value) || value.version !== CURRENT_EXCEL_WORKING_RESOURCE_METADATA_VERSION) {
    throw new ExcelWorkingResourceStoreError(
      `Excel working resource metadata version must be ${CURRENT_EXCEL_WORKING_RESOURCE_METADATA_VERSION}.`,
    );
  }

  const resource: ExcelWorkingResource = {
    sessionId: requireNonEmptyString(value.sessionId, 'sessionId'),
    sourceResourceId: requireNonEmptyString(value.sourceResourceId, 'sourceResourceId'),
    sourcePath: requireNonEmptyString(value.sourcePath, 'sourcePath'),
    workingPath: requireNonEmptyString(value.workingPath, 'workingPath'),
    revision: requireRevision(value.revision),
  };
  assertSafeResourceId(resource.sessionId, 'sessionId');
  assertSafeResourceId(resource.sourceResourceId, 'sourceResourceId');
  return resource;
}

function validateResource(resource: ExcelWorkingResource, expectedWorkingPath: string): void {
  assertSafeResourceId(resource.sessionId, 'sessionId');
  assertSafeResourceId(resource.sourceResourceId, 'sourceResourceId');
  if (resource.sourcePath.trim().length === 0) {
    throw new ExcelWorkingResourceStoreError('sourcePath is required.');
  }
  if (!Number.isSafeInteger(resource.revision) || resource.revision < 0) {
    throw new ExcelWorkingResourceStoreError('revision must be a non-negative safe integer.');
  }
  if (resolve(resource.workingPath) !== expectedWorkingPath) {
    throw new ExcelWorkingResourceStoreError(
      'workingPath must match the Session/resource workspace path.',
    );
  }
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ExcelWorkingResourceStoreError(`Excel working resource ${field} must be non-empty.`);
  }
  return value;
}

function requireRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ExcelWorkingResourceStoreError(
      'Excel working resource revision must be a non-negative safe integer.',
    );
  }
  return value;
}

function assertSafeResourceId(value: string, field: string): void {
  if (!resourceIdPattern.test(value)) {
    throw new ExcelWorkingResourceStoreError(
      `${field} must contain only letters, numbers, underscores, or hyphens and cannot escape workspaceRoot.`,
    );
  }
}

async function ensureDirectoryInsideWorkspace(
  directory: string,
  workspaceRoot: string,
): Promise<void> {
  try {
    await mkdir(directory, { recursive: true });
    await assertDirectoryInsideWorkspace(directory, workspaceRoot);
  } catch (error) {
    if (error instanceof ExcelWorkingResourceStoreError) throw error;
    throw new ExcelWorkingResourceStoreError(`Unable to create workspace directory ${directory}.`, {
      cause: error,
    });
  }
}

async function assertDirectoryInsideWorkspace(
  directory: string,
  workspaceRoot: string,
): Promise<void> {
  let stats;
  try {
    stats = await lstat(directory);
  } catch (error) {
    throw new ExcelWorkingResourceStoreError(`Workspace directory does not exist: ${directory}.`, {
      cause: error,
    });
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new ExcelWorkingResourceStoreError(
      `Workspace path must be a real directory inside workspaceRoot: ${directory}.`,
    );
  }
  let realDirectory: string;
  let realRoot: string;
  try {
    [realDirectory, realRoot] = await Promise.all([realpath(directory), realpath(workspaceRoot)]);
  } catch (error) {
    throw new ExcelWorkingResourceStoreError(
      `Unable to resolve workspace directory ${directory}.`,
      { cause: error },
    );
  }
  if (!isPathWithin(realRoot, realDirectory)) {
    throw new ExcelWorkingResourceStoreError(
      `Workspace path must remain within workspaceRoot: ${directory}.`,
    );
  }
}

async function assertRegularFileInsideWorkspace(
  filePath: string,
  workspaceRoot: string,
  label: string,
): Promise<void> {
  let stats;
  try {
    stats = await lstat(filePath);
  } catch (error) {
    if (isFileNotFoundError(error)) {
      throw new ExcelWorkingResourceStoreError(`${label} does not exist: ${filePath}.`, {
        cause: error,
      });
    }
    throw new ExcelWorkingResourceStoreError(`Unable to access ${label}: ${filePath}.`, {
      cause: error,
    });
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new ExcelWorkingResourceStoreError(
      `${label} must be a regular file inside workspaceRoot: ${filePath}.`,
    );
  }

  let realFilePath: string;
  let realRoot: string;
  try {
    [realFilePath, realRoot] = await Promise.all([realpath(filePath), realpath(workspaceRoot)]);
  } catch (error) {
    throw new ExcelWorkingResourceStoreError(`Unable to resolve ${label}: ${filePath}.`, {
      cause: error,
    });
  }
  if (!isPathWithin(realRoot, realFilePath)) {
    throw new ExcelWorkingResourceStoreError(
      `${label} must remain inside workspaceRoot: ${filePath}.`,
    );
  }
}

async function existsAsFile(filePath: string, workspaceRoot: string): Promise<boolean> {
  try {
    await assertRegularFileInsideWorkspace(filePath, workspaceRoot, 'metadata');
    return true;
  } catch (error) {
    if (
      error instanceof ExcelWorkingResourceStoreError &&
      error.message.includes('does not exist')
    ) {
      return false;
    }
    throw error;
  }
}

async function existsAsPath(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (isFileNotFoundError(error)) return false;
    throw error;
  }
}

async function removeTemporaryFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if (!isFileNotFoundError(error)) return;
  }
}

function isPathWithin(rootPath: string, candidatePath: string): boolean {
  const candidateRelativePath = relative(rootPath, candidatePath);
  return (
    candidateRelativePath === '' ||
    (!isAbsolute(candidateRelativePath) &&
      !candidateRelativePath.startsWith(`..${sep}`) &&
      candidateRelativePath !== '..' &&
      !candidateRelativePath.includes(`..${sep}`) &&
      !candidateRelativePath.startsWith('..\\') &&
      !candidateRelativePath.startsWith('..\/') &&
      !candidateRelativePath.includes('..\\') &&
      !candidateRelativePath.includes('..\/') &&
      !candidateRelativePath.includes(':'))
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new Error('Excel working resource operation was cancelled.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFileNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
