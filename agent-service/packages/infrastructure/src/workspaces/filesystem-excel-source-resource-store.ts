import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { ExcelResource, ExcelSourceResourceStore } from '@opspilot/application';

/** Current version of the Session-scoped Excel source locator document. */
export const CURRENT_EXCEL_SOURCE_RESOURCE_VERSION = 1 as const;

/** JSON representation of source locators kept outside Domain Session metadata. */
export interface ExcelSourceResourceRecord {
  readonly version: typeof CURRENT_EXCEL_SOURCE_RESOURCE_VERSION;
  readonly resources: readonly ExcelResource[];
}

/** Raised when the Excel source locator workspace is invalid or unavailable. */
export class ExcelSourceResourceStoreError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ExcelSourceResourceStoreError';
  }
}

/** Persists Excel source locators below workspaces/{sessionId}/ without storing them in Session. */
export class FileSystemExcelSourceResourceStore implements ExcelSourceResourceStore {
  private readonly workspaceRoot: string;

  public constructor(workspaceRoot: string) {
    if (typeof workspaceRoot !== 'string' || workspaceRoot.trim().length === 0) {
      throw new ExcelSourceResourceStoreError('workspaceRoot is required.');
    }
    this.workspaceRoot = resolve(workspaceRoot);
  }

  /** Loads a source locator, returning null when this Session has no persisted locator. */
  public async get(sessionId: string, resourceId: string): Promise<ExcelResource | null> {
    const filePath = this.getPath(sessionId);
    validateResourceId(resourceId);

    let content: string;
    try {
      await assertRegularFileInsideWorkspace(filePath, this.workspaceRoot);
      content = await readFile(filePath, 'utf8');
    } catch (error) {
      if (isFileNotFoundError(error)) return null;
      throw new ExcelSourceResourceStoreError(
        `Unable to read Excel source locators for Session ${sessionId}.`,
        { cause: error },
      );
    }

    const record = parseRecord(content, sessionId);
    const resource = record.resources.find((candidate) => candidate.id === resourceId);
    return resource === undefined ? null : { ...resource };
  }

  /** Saves or replaces one source locator using an atomic file replacement. */
  public async save(sessionId: string, resource: ExcelResource): Promise<void> {
    const filePath = this.getPath(sessionId);
    validateResourceId(resource.id);
    validateResource(resource);

    const sessionDirectory = join(this.workspaceRoot, sessionId);
    try {
      await mkdir(sessionDirectory, { recursive: true });
      await assertDirectoryInsideWorkspace(sessionDirectory, this.workspaceRoot);
    } catch (error) {
      if (error instanceof ExcelSourceResourceStoreError) throw error;
      throw new ExcelSourceResourceStoreError(
        `Unable to create Excel source workspace for Session ${sessionId}.`,
        { cause: error },
      );
    }

    const existing = await this.readExistingRecord(filePath, sessionId);
    const resources = existing.filter((candidate) => candidate.id !== resource.id);
    resources.push({ id: resource.id, filePath: resource.filePath });
    const temporaryPath = `${filePath}.tmp-${randomUUID()}`;
    try {
      await writeFile(
        temporaryPath,
        `${JSON.stringify(
          {
            version: CURRENT_EXCEL_SOURCE_RESOURCE_VERSION,
            resources,
          } satisfies ExcelSourceResourceRecord,
          null,
        )}\n`,
        { encoding: 'utf8', flag: 'wx' },
      );
      await rename(temporaryPath, filePath);
    } catch (error) {
      throw new ExcelSourceResourceStoreError(
        `Unable to atomically save Excel source locator for ${sessionId}/${resource.id}.`,
        { cause: error },
      );
    } finally {
      await removeTemporaryFile(temporaryPath);
    }
  }

  private async readExistingRecord(
    filePath: string,
    sessionId: string,
  ): Promise<readonly ExcelResource[]> {
    let content: string;
    try {
      await assertRegularFileInsideWorkspace(filePath, this.workspaceRoot);
      content = await readFile(filePath, 'utf8');
    } catch (error) {
      if (isFileNotFoundError(error)) return [];
      throw new ExcelSourceResourceStoreError(
        `Unable to read Excel source locators for Session ${sessionId}.`,
        { cause: error },
      );
    }
    return parseRecord(content, sessionId).resources;
  }

  private getPath(sessionId: string): string {
    validateSessionId(sessionId);
    return join(this.workspaceRoot, sessionId, 'excel-source-locators.json');
  }
}

function parseRecord(content: string, sessionId: string): ExcelSourceResourceRecord {
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch (error) {
    throw new ExcelSourceResourceStoreError(
      `Excel source locators for Session ${sessionId} contain invalid JSON.`,
      { cause: error },
    );
  }
  if (!isRecord(value) || value.version !== CURRENT_EXCEL_SOURCE_RESOURCE_VERSION) {
    throw new ExcelSourceResourceStoreError(
      `Excel source locator document version must be ${CURRENT_EXCEL_SOURCE_RESOURCE_VERSION}.`,
    );
  }
  if (!Array.isArray(value.resources)) {
    throw new ExcelSourceResourceStoreError(
      `Excel source locators for Session ${sessionId} must contain an array.`,
    );
  }

  const resources: ExcelResource[] = [];
  const ids = new Set<string>();
  for (const [index, item] of value.resources.entries()) {
    if (!isRecord(item) || !isNonEmptyString(item.id) || !isNonEmptyString(item.filePath)) {
      throw new ExcelSourceResourceStoreError(
        `Excel source locators resources[${index}] require id and filePath.`,
      );
    }
    const keys = Object.keys(item);
    if (keys.some((key) => key !== 'id' && key !== 'filePath')) {
      throw new ExcelSourceResourceStoreError(
        `Excel source locators resources[${index}] contain unsupported fields.`,
      );
    }
    validateResourceId(item.id);
    if (ids.has(item.id)) {
      throw new ExcelSourceResourceStoreError(
        `Excel source locators contain duplicate resource: ${item.id}.`,
      );
    }
    ids.add(item.id);
    resources.push({ id: item.id, filePath: item.filePath });
  }

  return { version: CURRENT_EXCEL_SOURCE_RESOURCE_VERSION, resources };
}

function validateResource(resource: ExcelResource): void {
  if (!isNonEmptyString(resource.filePath)) {
    throw new ExcelSourceResourceStoreError('Excel source resource filePath must be non-empty.');
  }
}

function validateSessionId(sessionId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(sessionId)) {
    throw new ExcelSourceResourceStoreError(`Invalid sessionId: ${sessionId}.`);
  }
}

function validateResourceId(resourceId: string): void {
  if (!isNonEmptyString(resourceId)) {
    throw new ExcelSourceResourceStoreError('Excel source resource id must be non-empty.');
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
    throw new ExcelSourceResourceStoreError(`Workspace directory does not exist: ${directory}.`, {
      cause: error,
    });
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new ExcelSourceResourceStoreError(
      `Workspace path must be a real directory inside workspaceRoot: ${directory}.`,
    );
  }
  const candidate = resolve(directory);
  const root = resolve(workspaceRoot);
  const candidateRelativePath = relative(root, candidate);
  if (
    isAbsolute(candidateRelativePath) ||
    candidateRelativePath === '..' ||
    candidateRelativePath.startsWith(`..${sep}`)
  ) {
    throw new ExcelSourceResourceStoreError(
      `Workspace path must remain inside workspaceRoot: ${directory}.`,
    );
  }
}

async function assertRegularFileInsideWorkspace(
  filePath: string,
  workspaceRoot: string,
): Promise<void> {
  const stats = await lstat(filePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new ExcelSourceResourceStoreError(
      `Workspace file must be a regular file inside workspaceRoot: ${filePath}.`,
    );
  }
  const candidate = resolve(filePath);
  const root = resolve(workspaceRoot);
  const candidateRelativePath = relative(root, candidate);
  if (
    isAbsolute(candidateRelativePath) ||
    candidateRelativePath === '..' ||
    candidateRelativePath.startsWith(`..${sep}`)
  ) {
    throw new ExcelSourceResourceStoreError(
      `Workspace file must remain inside workspaceRoot: ${filePath}.`,
    );
  }
}

async function removeTemporaryFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if (isFileNotFoundError(error)) return;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isFileNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
