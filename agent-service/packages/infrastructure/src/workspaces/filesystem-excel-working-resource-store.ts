import { constants as fsConstants } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import type {
  ExcelWorkingResource,
  ExcelWorkingResourceFileOperator,
  ExcelWorkingResourceRequest,
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
  readonly resourcesDirectory: string;
  readonly directory: string;
  readonly working: string;
  readonly metadata: string;
}

/**
 * Persists Session-scoped Excel working resources below one workspace root.
 * The same adapter atomically initializes a complete working resource for the Application manager.
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

  /**
   * Builds a complete working resource in a sibling staging directory and publishes
   * it with one directory rename. The final resource path is never used as a copy target.
   */
  public async initializeWorkingResource(
    input: ExcelWorkingResourceRequest,
  ): Promise<ExcelWorkingResource> {
    const paths = this.getPaths(input.sessionId, input.sourceResourceId);
    const resource: ExcelWorkingResource = {
      sessionId: input.sessionId,
      sourceResourceId: input.sourceResourceId,
      sourcePath: input.sourcePath,
      workingPath: paths.working,
      revision: 0,
    };
    validateResource(resource, paths.working);
    throwIfAborted(input.signal);

    await ensureDirectoryInsideWorkspace(paths.resourcesDirectory, this.workspaceRoot);
    await this.removeSafeLegacyOrphan(paths);
    await this.removeStaleStagingDirectories(paths.resourcesDirectory, input.sourceResourceId);
    if (await existsAsPath(paths.directory)) {
      throw new ExcelWorkingResourceStoreError(
        `Cannot initialize Excel working resource ${input.sessionId}/${input.sourceResourceId}: ` +
          'the final resource directory already exists.',
      );
    }

    const stagingDirectory = join(
      paths.resourcesDirectory,
      `.creating-${input.sourceResourceId}-${randomUUID()}`,
    );
    const stagedWorkingPath = join(stagingDirectory, 'working.xlsx');
    const stagedMetadataPath = join(stagingDirectory, 'metadata.json');
    let published = false;

    try {
      await mkdir(stagingDirectory);
      await assertDirectoryInsideWorkspace(stagingDirectory, this.workspaceRoot);
      throwIfAborted(input.signal);

      await copyFile(input.sourcePath, stagedWorkingPath, fsConstants.COPYFILE_EXCL);
      throwIfAborted(input.signal);
      await this.writeStagedMetadata(stagedMetadataPath, resource);
      throwIfAborted(input.signal);

      await assertRegularFileInsideWorkspace(
        stagedWorkingPath,
        this.workspaceRoot,
        'staged working copy',
      );
      await assertRegularFileInsideWorkspace(
        stagedMetadataPath,
        this.workspaceRoot,
        'staged metadata',
      );
      await this.assertStagedMetadata(stagedMetadataPath, resource);
      throwIfAborted(input.signal);

      await this.publishStagingDirectory(stagingDirectory, paths.directory, input);
      published = true;
      return resource;
    } catch (error) {
      if (error instanceof ExcelWorkingResourceStoreError) throw error;
      throw new ExcelWorkingResourceStoreError(
        `Unable to initialize Excel working resource ${input.sessionId}/${input.sourceResourceId}.`,
        { cause: error },
      );
    } finally {
      if (!published) await removeDirectoryIfPresent(stagingDirectory);
    }
  }

  /** Atomically saves a validated metadata snapshot and never moves revision backwards. */
  public async save(resource: ExcelWorkingResource, signal?: AbortSignal): Promise<void> {
    const paths = this.getPaths(resource.sessionId, resource.sourceResourceId);
    validateResource(resource, paths.working);
    throwIfAborted(signal);
    await assertRegularFileInsideWorkspace(paths.working, this.workspaceRoot, 'working copy');
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

  private async assertStagedMetadata(
    metadataPath: string,
    expectedResource: ExcelWorkingResource,
  ): Promise<void> {
    const stagedResource = parseMetadata(await readFile(metadataPath, 'utf8'));
    if (
      stagedResource.sessionId !== expectedResource.sessionId ||
      stagedResource.sourceResourceId !== expectedResource.sourceResourceId ||
      stagedResource.sourcePath !== expectedResource.sourcePath ||
      resolve(stagedResource.workingPath) !== expectedResource.workingPath ||
      stagedResource.revision !== 0
    ) {
      throw new ExcelWorkingResourceStoreError(
        'Staged Excel working resource metadata does not match the resource being published.',
      );
    }
  }

  /** Writes staged metadata; kept as a filesystem-local seam for failure handling tests. */
  protected async writeStagedMetadata(
    metadataPath: string,
    resource: ExcelWorkingResource,
  ): Promise<void> {
    await writeFile(metadataPath, serializeMetadata(resource), {
      encoding: 'utf8',
      flag: 'wx',
    });
  }

  /** Atomically publishes a complete staging directory without replacing its target. */
  protected async publishStagingDirectory(
    stagingDirectory: string,
    finalDirectory: string,
    input: ExcelWorkingResourceRequest,
  ): Promise<void> {
    if (await existsAsPath(finalDirectory)) {
      throw new ExcelWorkingResourceStoreError(
        `Cannot publish Excel working resource ${input.sessionId}/${input.sourceResourceId}: ` +
          'the final resource directory already exists.',
      );
    }
    await rename(stagingDirectory, finalDirectory);
  }

  private async removeSafeLegacyOrphan(paths: WorkingResourcePaths): Promise<void> {
    if (!(await existsAsPath(paths.directory))) return;
    await assertDirectoryInsideWorkspace(paths.directory, this.workspaceRoot);
    const entries = await readdir(paths.directory, { withFileTypes: true });
    const isSafeOrphan =
      entries.length === 0 ||
      (entries.length === 1 &&
        entries[0]?.name === 'working.xlsx' &&
        entries[0].isFile() &&
        !entries[0].isSymbolicLink());
    if (!isSafeOrphan) {
      throw new ExcelWorkingResourceStoreError(
        `Cannot initialize ${paths.directory}: an unpublished resource directory contains unexpected files.`,
      );
    }
    await rm(paths.directory, { recursive: true, force: true });
  }

  private async removeStaleStagingDirectories(
    resourcesDirectory: string,
    sourceResourceId: string,
  ): Promise<void> {
    const prefix = `.creating-${sourceResourceId}-`;
    const entries = await readdir(resourcesDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.name.startsWith(prefix) || !entry.isDirectory() || entry.isSymbolicLink()) {
        continue;
      }
      await assertDirectoryInsideWorkspace(
        join(resourcesDirectory, entry.name),
        this.workspaceRoot,
      );
      await rm(join(resourcesDirectory, entry.name), { recursive: true, force: true });
    }
  }

  private getWorkingPath(sessionId: string, sourceResourceId: string): string {
    return this.getPaths(sessionId, sourceResourceId).working;
  }

  private getPaths(sessionId: string, sourceResourceId: string): WorkingResourcePaths {
    assertSafeResourceId(sessionId, 'sessionId');
    assertSafeResourceId(sourceResourceId, 'sourceResourceId');
    const resourcesDirectory = join(this.workspaceRoot, sessionId, 'resources');
    const directory = join(this.workspaceRoot, sessionId, 'resources', sourceResourceId);
    return {
      resourcesDirectory,
      directory,
      working: join(directory, 'working.xlsx'),
      metadata: join(directory, 'metadata.json'),
    };
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

async function removeDirectoryIfPresent(directory: string): Promise<void> {
  try {
    await rm(directory, { recursive: true, force: true });
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
