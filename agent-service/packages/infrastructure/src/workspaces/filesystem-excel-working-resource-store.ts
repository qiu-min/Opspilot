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
  ExcelWorkingMutationContext,
  ExcelWorkingMutationReceiptRecord,
  ExcelWorkingMutationRequest,
  ExcelWorkingResource,
  ExcelWorkingResourceFileOperator,
  ExcelWorkingResourceRequest,
  ExcelWorkingResourceStore,
} from '@opspilot/application';

/** Current version of the committed working-resource manifest. */
export const CURRENT_EXCEL_WORKING_RESOURCE_MANIFEST_VERSION = 2 as const;
/** Maximum number of mutation receipts retained per resource. */
export const MAX_EXCEL_WORKING_RESOURCE_MUTATION_RECEIPTS = 32 as const;

const resourceIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;
const revisionFilePattern = /^revision-(\d+)-([a-f0-9-]+)\.xlsx$/u;
const mutationFilePattern = /^mutation-([a-f0-9-]+)\.xlsx$/u;

/** Raised when an Excel working-resource filesystem layout is invalid or unavailable. */
export class ExcelWorkingResourceStoreError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ExcelWorkingResourceStoreError';
  }
}

/** Generic JSON receipt recorded for one successful Tool call. */
export interface ExcelWorkingResourceMutationRecord {
  readonly mutationId: string;
  readonly revision: number;
  readonly receipt: unknown;
}

/** Durable manifest whose atomic replacement selects the committed workbook revision. */
export interface ExcelWorkingResourceManifestRecord {
  readonly version: typeof CURRENT_EXCEL_WORKING_RESOURCE_MANIFEST_VERSION;
  readonly sessionId: string;
  readonly sourceResourceId: string;
  readonly sourcePath: string;
  readonly revision: number;
  readonly file: string;
  readonly committedMutations: readonly ExcelWorkingResourceMutationRecord[];
}

interface LegacyExcelWorkingResourceMetadataRecord {
  readonly version: 1;
  readonly sessionId: string;
  readonly sourceResourceId: string;
  readonly sourcePath: string;
  readonly workingPath: string;
  readonly revision: number;
}

interface WorkingResourcePaths {
  readonly resourcesDirectory: string;
  readonly directory: string;
  readonly current: string;
  readonly revisions: string;
  readonly staging: string;
  readonly legacyWorking: string;
  readonly legacyMetadata: string;
}

/**
 * Persists committed Excel revisions below one workspace root. The current manifest is the
 * sole commit pointer; staging and candidate files are never returned to readers.
 */
export class FileSystemExcelWorkingResourceStore
  implements ExcelWorkingResourceStore, ExcelWorkingResourceFileOperator
{
  private readonly workspaceRoot: string;
  private readonly migrationLocks = new Map<string, Promise<void>>();

  public constructor(workspaceRoot: string) {
    if (typeof workspaceRoot !== 'string' || workspaceRoot.trim().length === 0) {
      throw new ExcelWorkingResourceStoreError('workspaceRoot is required.');
    }
    this.workspaceRoot = resolve(workspaceRoot);
  }

  /** Loads the current committed revision, lazily migrating a legacy working copy if needed. */
  public async get(
    sessionId: string,
    sourceResourceId: string,
    signal?: AbortSignal,
  ): Promise<ExcelWorkingResource | null> {
    const paths = this.getPaths(sessionId, sourceResourceId);
    throwIfAborted(signal);
    let manifest = await this.readCurrentManifest(paths, sessionId, sourceResourceId);
    if (manifest === null) {
      const key = `${sessionId}\u0000${sourceResourceId}`;
      manifest = await this.withMigrationLock(key, async () => {
        const afterWaiting = await this.readCurrentManifest(paths, sessionId, sourceResourceId);
        return (
          afterWaiting ??
          (await this.migrateLegacyResource(paths, sessionId, sourceResourceId, signal))
        );
      });
    }
    if (manifest === null) return null;

    const workingPath = await this.validateManifestFile(paths, manifest);
    throwIfAborted(signal);
    return resourceFromManifest(manifest, workingPath);
  }

  /** Returns one opaque durable receipt, or null when the callId has never committed here. */
  public async getMutationReceipt(
    sessionId: string,
    sourceResourceId: string,
    mutationId: string,
    signal?: AbortSignal,
  ): Promise<ExcelWorkingMutationReceiptRecord | null> {
    const paths = this.getPaths(sessionId, sourceResourceId);
    requireNonEmptyString(mutationId, 'mutationId');
    throwIfAborted(signal);
    const manifest = await this.readCurrentManifest(paths, sessionId, sourceResourceId);
    if (manifest === null) return null;
    const committed = manifest.committedMutations.find((item) => item.mutationId === mutationId);
    throwIfAborted(signal);
    return committed === undefined
      ? null
      : { revision: committed.revision, receipt: committed.receipt };
  }

  /** Copies the committed workbook or immutable source into a private staging file. */
  public async prepareMutation(
    input: ExcelWorkingMutationRequest,
  ): Promise<ExcelWorkingMutationContext> {
    const paths = this.getPaths(input.sessionId, input.sourceResourceId);
    requireNonEmptyString(input.sourcePath, 'sourcePath');
    requireNonEmptyString(input.mutationId, 'mutationId');
    throwIfAborted(input.signal);

    const existing = await this.get(input.sessionId, input.sourceResourceId, input.signal);
    if (existing !== null && existing.sourcePath !== input.sourcePath) {
      throw new ExcelWorkingResourceStoreError(
        `Excel working resource source mismatch for ${input.sessionId}/${input.sourceResourceId}.`,
      );
    }
    let manifest = await this.readCurrentManifest(paths, input.sessionId, input.sourceResourceId);
    await ensureDirectoryInsideWorkspace(paths.directory, this.workspaceRoot);
    if (manifest !== null) await this.reconcileOrphans(paths, manifest);
    else await this.reconcileOrphans(paths, null);

    const baseRevision = manifest?.revision ?? 0;
    if (baseRevision === Number.MAX_SAFE_INTEGER) {
      throw new ExcelWorkingResourceStoreError(
        `Excel working resource revision cannot advance beyond ${Number.MAX_SAFE_INTEGER}.`,
      );
    }
    const targetRevision = baseRevision + 1;
    const sourceFilePath =
      manifest === null ? input.sourcePath : await this.validateManifestFile(paths, manifest);
    const mutationToken = randomUUID();
    const stagingPath = join(paths.staging, `mutation-${mutationToken}.xlsx`);
    await ensureDirectoryInsideWorkspace(paths.staging, this.workspaceRoot);
    throwIfAborted(input.signal);
    try {
      await copyFile(sourceFilePath, stagingPath, fsConstants.COPYFILE_EXCL);
      throwIfAborted(input.signal);
      await assertRegularFileInsideResource(
        stagingPath,
        paths.directory,
        this.workspaceRoot,
        'staged workbook',
      );
      return { stagingPath, baseRevision, targetRevision };
    } catch (error) {
      try {
        await removeTemporaryFile(stagingPath);
      } catch {
        // An orphan staging file is safe and will be reconciled on a later mutation.
      }
      if (error instanceof ExcelWorkingResourceStoreError) throw error;
      throw new ExcelWorkingResourceStoreError(
        `Unable to prepare Excel mutation for ${input.sessionId}/${input.sourceResourceId}.`,
        { cause: error },
      );
    }
  }

  /** Publishes an immutable revision and atomically replaces current.json as the commit point. */
  public async commitMutation(
    input: ExcelWorkingMutationRequest,
    context: ExcelWorkingMutationContext,
    receipt: unknown,
  ): Promise<ExcelWorkingResource> {
    const paths = this.getPaths(input.sessionId, input.sourceResourceId);
    requireNonEmptyString(input.sourcePath, 'sourcePath');
    requireNonEmptyString(input.mutationId, 'mutationId');
    assertJsonSerializableReceipt(receipt);
    const stagingPath = this.validateStagingContext(paths, context);
    await assertRegularFileInsideResource(
      stagingPath,
      paths.directory,
      this.workspaceRoot,
      'staged workbook',
    );
    const existing = await this.get(input.sessionId, input.sourceResourceId);
    if (existing !== null && existing.sourcePath !== input.sourcePath) {
      throw new ExcelWorkingResourceStoreError(
        `Excel working resource source mismatch for ${input.sessionId}/${input.sourceResourceId}.`,
      );
    }
    const current = await this.readCurrentManifest(paths, input.sessionId, input.sourceResourceId);
    const currentRevision = current?.revision ?? 0;
    if (currentRevision !== context.baseRevision) {
      throw new ExcelWorkingResourceStoreError(
        `Excel mutation base revision changed: expected ${context.baseRevision}, received ${currentRevision}.`,
      );
    }
    if (current?.committedMutations.some((item) => item.mutationId === input.mutationId)) {
      throw new ExcelWorkingResourceStoreError(
        `Mutation ${input.mutationId} is already committed and cannot be committed again.`,
      );
    }
    if (context.targetRevision !== currentRevision + 1) {
      throw new ExcelWorkingResourceStoreError('Excel mutation target revision is invalid.');
    }

    await ensureDirectoryInsideWorkspace(paths.revisions, this.workspaceRoot);
    const candidateName = `revision-${context.targetRevision}-${randomUUID()}.xlsx`;
    const candidatePath = join(paths.revisions, candidateName);
    await this.publishRevision(stagingPath, candidatePath);
    await assertRegularFileInsideResource(
      candidatePath,
      paths.directory,
      this.workspaceRoot,
      'candidate workbook revision',
    );

    const nextManifest: ExcelWorkingResourceManifestRecord = {
      version: CURRENT_EXCEL_WORKING_RESOURCE_MANIFEST_VERSION,
      sessionId: input.sessionId,
      sourceResourceId: input.sourceResourceId,
      sourcePath: input.sourcePath,
      revision: context.targetRevision,
      file: `revisions/${candidateName}`,
      committedMutations: [
        ...(current?.committedMutations ?? []),
        { mutationId: input.mutationId, revision: context.targetRevision, receipt },
      ].slice(-MAX_EXCEL_WORKING_RESOURCE_MUTATION_RECEIPTS),
    };
    const temporaryManifestPath = `${paths.current}.tmp-${randomUUID()}`;
    try {
      await writeFile(temporaryManifestPath, serializeManifest(nextManifest), {
        encoding: 'utf8',
        flag: 'wx',
      });
      await this.replaceCurrentPointer(temporaryManifestPath, paths.current);
    } catch (error) {
      try {
        await removeTemporaryFile(temporaryManifestPath);
      } catch {
        // A pointer temp file is not committed and is safe to clean on the next mutation.
      }
      if (error instanceof ExcelWorkingResourceStoreError) throw error;
      throw new ExcelWorkingResourceStoreError(
        `Unable to atomically commit Excel revision ${context.targetRevision}.`,
        { cause: error },
      );
    }

    // The pointer replacement above is the commit point. Cleanup can never roll it back.
    try {
      await this.reconcileOrphans(paths, nextManifest);
    } catch {
      // Cleanup failure leaves only bounded orphans and cannot invalidate the committed revision.
    }
    const workingPath = await this.validateManifestFile(paths, nextManifest);
    return resourceFromManifest(nextManifest, workingPath);
  }

  /** Removes an uncommitted staging file after callback failure or cancellation. */
  public async abortMutation(
    input: ExcelWorkingMutationRequest,
    context: ExcelWorkingMutationContext,
  ): Promise<void> {
    const paths = this.getPaths(input.sessionId, input.sourceResourceId);
    const stagingPath = this.validateStagingContext(paths, context);
    await removeTemporaryFile(stagingPath);
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

  /** Atomically renames a prepared candidate revision into the immutable revisions directory. */
  protected async publishRevision(stagingPath: string, candidatePath: string): Promise<void> {
    await rename(stagingPath, candidatePath);
  }

  /** Atomically replaces the durable current pointer with its complete prepared snapshot. */
  protected async replaceCurrentPointer(temporaryPath: string, currentPath: string): Promise<void> {
    await rename(temporaryPath, currentPath);
  }

  private async readCurrentManifest(
    paths: WorkingResourcePaths,
    sessionId: string,
    sourceResourceId: string,
  ): Promise<ExcelWorkingResourceManifestRecord | null> {
    if (!(await existsAsRegularFile(paths.current, this.workspaceRoot, 'current manifest'))) {
      return null;
    }
    const manifest = parseManifest(await readFile(paths.current, 'utf8'));
    if (manifest.sessionId !== sessionId || manifest.sourceResourceId !== sourceResourceId) {
      throw new ExcelWorkingResourceStoreError(
        `Excel working resource manifest identity does not match ${sessionId}/${sourceResourceId}.`,
      );
    }
    return manifest;
  }

  private async validateManifestFile(
    paths: WorkingResourcePaths,
    manifest: ExcelWorkingResourceManifestRecord,
  ): Promise<string> {
    const segments = manifest.file.split('/');
    const revisionPath = resolve(paths.directory, ...segments);
    if (!isPathWithin(resolve(paths.directory), revisionPath) || revisionPath === resolve(paths.directory)) {
      throw new ExcelWorkingResourceStoreError('Manifest file escapes its resource workspace.');
    }
    await assertRegularFileInsideResource(
      revisionPath,
      paths.directory,
      this.workspaceRoot,
      'current workbook revision',
    );
    return revisionPath;
  }

  private async migrateLegacyResource(
    paths: WorkingResourcePaths,
    sessionId: string,
    sourceResourceId: string,
    signal?: AbortSignal,
  ): Promise<ExcelWorkingResourceManifestRecord | null> {
    const hasMetadata = await existsAsRegularFile(
      paths.legacyMetadata,
      this.workspaceRoot,
      'legacy metadata',
    );
    const hasWorkingFile = await existsAsPath(paths.legacyWorking);
    if (!hasMetadata && !hasWorkingFile) return null;
    if (!hasMetadata) {
      throw new ExcelWorkingResourceStoreError(
        `Legacy working.xlsx exists without metadata for ${sessionId}/${sourceResourceId}; preserving it for recovery.`,
      );
    }

    const legacy = parseLegacyMetadata(await readFile(paths.legacyMetadata, 'utf8'));
    if (legacy.sessionId !== sessionId || legacy.sourceResourceId !== sourceResourceId) {
      throw new ExcelWorkingResourceStoreError(
        `Legacy Excel working resource identity does not match ${sessionId}/${sourceResourceId}.`,
      );
    }
    if (resolve(legacy.workingPath) !== resolve(paths.legacyWorking)) {
      throw new ExcelWorkingResourceStoreError(
        'Legacy Excel working resource path does not match its workspace location.',
      );
    }
    await assertRegularFileInsideResource(
      paths.legacyWorking,
      paths.directory,
      this.workspaceRoot,
      'legacy working copy',
    );
    throwIfAborted(signal);

    await ensureDirectoryInsideWorkspace(paths.revisions, this.workspaceRoot);
    await ensureDirectoryInsideWorkspace(paths.staging, this.workspaceRoot);
    const migrationToken = randomUUID();
    const stagedPath = join(paths.staging, `mutation-${migrationToken}.xlsx`);
    const candidateName = `revision-${legacy.revision}-${migrationToken}.xlsx`;
    const candidatePath = join(paths.revisions, candidateName);
    try {
      await copyFile(paths.legacyWorking, stagedPath, fsConstants.COPYFILE_EXCL);
      throwIfAborted(signal);
      await assertRegularFileInsideResource(
        stagedPath,
        paths.directory,
        this.workspaceRoot,
        'staged legacy workbook',
      );
      await this.publishRevision(stagedPath, candidatePath);
      await assertRegularFileInsideResource(
        candidatePath,
        paths.directory,
        this.workspaceRoot,
        'migrated workbook revision',
      );
      const manifest: ExcelWorkingResourceManifestRecord = {
        version: CURRENT_EXCEL_WORKING_RESOURCE_MANIFEST_VERSION,
        sessionId,
        sourceResourceId,
        sourcePath: legacy.sourcePath,
        revision: legacy.revision,
        file: `revisions/${candidateName}`,
        committedMutations: [],
      };
      const temporaryManifestPath = `${paths.current}.tmp-${randomUUID()}`;
      await writeFile(temporaryManifestPath, serializeManifest(manifest), {
        encoding: 'utf8',
        flag: 'wx',
      });
      // This is the migration commit point; cancellation after here cannot undo the pointer.
      await this.replaceCurrentPointer(temporaryManifestPath, paths.current);
      try {
        await this.reconcileOrphans(paths, manifest);
      } catch {
        // The copied committed revision remains authoritative if cleanup fails.
      }
      return manifest;
    } catch (error) {
      try {
        await removeTemporaryFile(stagedPath);
      } catch {
        // The legacy source remains intact and an orphan stage is safe to remove later.
      }
      if (error instanceof ExcelWorkingResourceStoreError) throw error;
      throw new ExcelWorkingResourceStoreError(
        `Unable to migrate legacy Excel working resource ${sessionId}/${sourceResourceId}.`,
        { cause: error },
      );
    }
  }

  private async reconcileOrphans(
    paths: WorkingResourcePaths,
    current: ExcelWorkingResourceManifestRecord | null,
  ): Promise<void> {
    await this.removeDirectoryIfPresentInsideWorkspace(paths.staging, 'staging directory');
    if (await existsAsPath(paths.revisions)) {
      await assertDirectoryInsideWorkspace(paths.revisions, this.workspaceRoot);
      const entries = await readdir(paths.revisions, { withFileTypes: true });
      const revisions = entries
        .filter((entry) => entry.isFile() && !entry.isSymbolicLink())
        .map((entry) => ({ name: entry.name, match: revisionFilePattern.exec(entry.name) }))
        .filter((entry): entry is { name: string; match: RegExpExecArray } => entry.match !== null)
        .map((entry) => ({ name: entry.name, revision: Number(entry.match[1]) }));
      const previous = revisions
        .filter((entry) => entry.revision < (current?.revision ?? 0))
        .sort((left, right) => right.revision - left.revision)[0];
      const retained = new Set(
        [current?.file.split('/').at(-1), previous?.name].filter(
          (name): name is string => name !== undefined,
        ),
      );
      for (const entry of entries) {
        if (!entry.isFile() || entry.isSymbolicLink() || retained.has(entry.name)) continue;
        if (!revisionFilePattern.test(entry.name)) continue;
        await assertRegularFileInsideResource(
          join(paths.revisions, entry.name),
          paths.directory,
          this.workspaceRoot,
          'orphan workbook revision',
        );
        await unlink(join(paths.revisions, entry.name));
      }
    }

    if (current !== null) {
      await this.removeLegacyFileIfPresent(paths.legacyWorking, paths.directory, 'legacy working copy');
      await this.removeLegacyFileIfPresent(paths.legacyMetadata, paths.directory, 'legacy metadata');
    }
    if (await existsAsPath(paths.directory)) {
      const entries = await readdir(paths.directory, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || entry.isSymbolicLink() || !/^current\.json\.tmp-[a-f0-9-]+$/u.test(entry.name)) {
          continue;
        }
        await assertRegularFileInsideResource(
          join(paths.directory, entry.name),
          paths.directory,
          this.workspaceRoot,
          'orphan current manifest temp file',
        );
        await unlink(join(paths.directory, entry.name));
      }
    }
  }

  private async removeDirectoryIfPresentInsideWorkspace(
    directory: string,
    label: string,
  ): Promise<void> {
    if (!(await existsAsPath(directory))) return;
    await assertDirectoryInsideWorkspace(directory, this.workspaceRoot);
    try {
      await rm(directory, { recursive: true, force: true });
    } catch (error) {
      throw new ExcelWorkingResourceStoreError(`Unable to remove ${label}: ${directory}.`, {
        cause: error,
      });
    }
  }

  private async removeLegacyFileIfPresent(
    filePath: string,
    resourceDirectory: string,
    label: string,
  ): Promise<void> {
    if (!(await existsAsPath(filePath))) return;
    await assertRegularFileInsideResource(
      filePath,
      resourceDirectory,
      this.workspaceRoot,
      label,
    );
    await unlink(filePath);
  }

  private validateStagingContext(
    paths: WorkingResourcePaths,
    context: ExcelWorkingMutationContext,
  ): string {
    if (
      !Number.isSafeInteger(context.baseRevision) ||
      context.baseRevision < 0 ||
      !Number.isSafeInteger(context.targetRevision) ||
      context.targetRevision !== context.baseRevision + 1
    ) {
      throw new ExcelWorkingResourceStoreError('Excel mutation staging context is invalid.');
    }
    const stagingPath = resolve(context.stagingPath);
    const stagingDirectory = resolve(paths.staging);
    const fileName = stagingPath.slice(stagingDirectory.length + sep.length);
    if (
      !isPathWithin(stagingDirectory, stagingPath) ||
      !mutationFilePattern.test(fileName) ||
      fileName.includes(sep)
    ) {
      throw new ExcelWorkingResourceStoreError(
        'Excel mutation staging path must be a generated file inside its staging directory.',
      );
    }
    return stagingPath;
  }

  private async withMigrationLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.migrationLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    this.migrationLocks.set(key, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.migrationLocks.get(key) === current) this.migrationLocks.delete(key);
    }
  }

  private getPaths(sessionId: string, sourceResourceId: string): WorkingResourcePaths {
    assertSafeResourceId(sessionId, 'sessionId');
    assertSafeResourceId(sourceResourceId, 'sourceResourceId');
    const resourcesDirectory = join(this.workspaceRoot, sessionId, 'resources');
    const directory = join(resourcesDirectory, sourceResourceId);
    return {
      resourcesDirectory,
      directory,
      current: join(directory, 'current.json'),
      revisions: join(directory, 'revisions'),
      staging: join(directory, 'staging'),
      legacyWorking: join(directory, 'working.xlsx'),
      legacyMetadata: join(directory, 'metadata.json'),
    };
  }
}

/** Serializes the manifest without storing absolute revision paths. */
function serializeManifest(manifest: ExcelWorkingResourceManifestRecord): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** Parses and validates the current manifest and its bounded generic receipts. */
function parseManifest(content: string): ExcelWorkingResourceManifestRecord {
  const value = parseJson(content, 'Excel working resource manifest');
  if (
    !isRecord(value) ||
    value.version !== CURRENT_EXCEL_WORKING_RESOURCE_MANIFEST_VERSION ||
    !Array.isArray(value.committedMutations)
  ) {
    throw new ExcelWorkingResourceStoreError(
      `Excel working resource manifest version must be ${CURRENT_EXCEL_WORKING_RESOURCE_MANIFEST_VERSION}.`,
    );
  }
  const sessionId = requireNonEmptyString(value.sessionId, 'sessionId');
  const sourceResourceId = requireNonEmptyString(value.sourceResourceId, 'sourceResourceId');
  const sourcePath = requireNonEmptyString(value.sourcePath, 'sourcePath');
  const revision = requireRevision(value.revision);
  const file = requireNonEmptyString(value.file, 'file');
  assertSafeResourceId(sessionId, 'sessionId');
  assertSafeResourceId(sourceResourceId, 'sourceResourceId');
  validateManifestRelativeFile(file, revision);
  if (value.committedMutations.length > MAX_EXCEL_WORKING_RESOURCE_MUTATION_RECEIPTS) {
    throw new ExcelWorkingResourceStoreError('Excel manifest contains too many mutation receipts.');
  }
  const seenMutationIds = new Set<string>();
  const committedMutations = value.committedMutations.map((candidate): ExcelWorkingResourceMutationRecord => {
    if (!isRecord(candidate)) {
      throw new ExcelWorkingResourceStoreError('Excel mutation receipt record must be an object.');
    }
    const mutationId = requireNonEmptyString(candidate.mutationId, 'mutationId');
    const mutationRevision = requireRevision(candidate.revision);
    if (mutationRevision > revision || seenMutationIds.has(mutationId)) {
      throw new ExcelWorkingResourceStoreError('Excel mutation receipt record is inconsistent.');
    }
    assertJsonSerializableReceipt(candidate.receipt);
    seenMutationIds.add(mutationId);
    return { mutationId, revision: mutationRevision, receipt: candidate.receipt };
  });
  return {
    version: CURRENT_EXCEL_WORKING_RESOURCE_MANIFEST_VERSION,
    sessionId,
    sourceResourceId,
    sourcePath,
    revision,
    file,
    committedMutations,
  };
}

/** Parses the legacy mutable-working-copy metadata without assuming revision zero is unchanged. */
function parseLegacyMetadata(content: string): LegacyExcelWorkingResourceMetadataRecord {
  const value = parseJson(content, 'Legacy Excel working resource metadata');
  if (!isRecord(value) || value.version !== 1) {
    throw new ExcelWorkingResourceStoreError('Legacy Excel working resource metadata is invalid.');
  }
  const record: LegacyExcelWorkingResourceMetadataRecord = {
    version: 1,
    sessionId: requireNonEmptyString(value.sessionId, 'sessionId'),
    sourceResourceId: requireNonEmptyString(value.sourceResourceId, 'sourceResourceId'),
    sourcePath: requireNonEmptyString(value.sourcePath, 'sourcePath'),
    workingPath: requireNonEmptyString(value.workingPath, 'workingPath'),
    revision: requireRevision(value.revision),
  };
  assertSafeResourceId(record.sessionId, 'sessionId');
  assertSafeResourceId(record.sourceResourceId, 'sourceResourceId');
  return record;
}

/** Validates that the manifest revision is represented by a safe workspace-relative file. */
function validateManifestRelativeFile(file: string, revision: number): void {
  const segments = file.split('/');
  const match = revisionFilePattern.exec(segments[1] ?? '');
  if (
    isAbsolute(file) ||
    file.includes('\\') ||
    segments.length !== 2 ||
    segments[0] !== 'revisions' ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..') ||
    match === null ||
    Number(match[1]) !== revision
  ) {
    throw new ExcelWorkingResourceStoreError(
      'Excel manifest file must be a safe relative path to its committed revision.',
    );
  }
}

/** Converts a validated manifest into the Application-facing current resource path. */
function resourceFromManifest(
  manifest: ExcelWorkingResourceManifestRecord,
  workingPath: string,
): ExcelWorkingResource {
  return {
    sessionId: manifest.sessionId,
    sourceResourceId: manifest.sourceResourceId,
    sourcePath: manifest.sourcePath,
    workingPath,
    revision: manifest.revision,
  };
}

/** Parses JSON and wraps syntax errors in a storage-specific error. */
function parseJson(content: string, label: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch (error) {
    throw new ExcelWorkingResourceStoreError(`${label} contains invalid JSON.`, { cause: error });
  }
}

/** Validates a receipt before writing or replaying it as opaque JSON data. */
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
      throw new ExcelWorkingResourceStoreError(
        'Excel mutation receipt must be a JSON-serializable value.',
      );
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
      throw new ExcelWorkingResourceStoreError(
        'Excel mutation receipt must be a JSON-serializable value.',
      );
    }
    for (const item of Object.values(candidate as Record<string, unknown>)) visit(item);
    visited.delete(candidate);
  };
  visit(value);
}

/** Validates a required non-empty metadata string. */
function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ExcelWorkingResourceStoreError(`Excel working resource ${field} must be non-empty.`);
  }
  return value;
}

/** Validates a non-negative safe-integer revision. */
function requireRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ExcelWorkingResourceStoreError(
      'Excel working resource revision must be a non-negative safe integer.',
    );
  }
  return value;
}

/** Rejects IDs that could escape their resource workspace directory. */
function assertSafeResourceId(value: string, field: string): void {
  if (!resourceIdPattern.test(value)) {
    throw new ExcelWorkingResourceStoreError(
      `${field} must contain only letters, numbers, underscores, or hyphens and cannot escape workspaceRoot.`,
    );
  }
}

/** Creates and validates one real directory below the configured workspace root. */
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

/** Ensures a directory is a real directory contained in workspaceRoot. */
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

/** Ensures a revision, stage, or metadata file is a regular file within its resource directory. */
async function assertRegularFileInsideResource(
  filePath: string,
  resourceDirectory: string,
  workspaceRoot: string,
  label: string,
): Promise<void> {
  await assertDirectoryInsideWorkspace(resourceDirectory, workspaceRoot);
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
      `${label} must be a regular file inside its resource workspace: ${filePath}.`,
    );
  }
  let realFilePath: string;
  let realResourcePath: string;
  let realRoot: string;
  try {
    [realFilePath, realResourcePath, realRoot] = await Promise.all([
      realpath(filePath),
      realpath(resourceDirectory),
      realpath(workspaceRoot),
    ]);
  } catch (error) {
    throw new ExcelWorkingResourceStoreError(`Unable to resolve ${label}: ${filePath}.`, {
      cause: error,
    });
  }
  if (!isPathWithin(realResourcePath, realFilePath) || !isPathWithin(realRoot, realFilePath)) {
    throw new ExcelWorkingResourceStoreError(
      `${label} must remain inside its resource workspace: ${filePath}.`,
    );
  }
}

/** Returns whether a path is a safe regular file, without treating invalid paths as missing. */
async function existsAsRegularFile(
  filePath: string,
  workspaceRoot: string,
  label: string,
): Promise<boolean> {
  try {
    await assertRegularFileInsideWorkspace(filePath, workspaceRoot, label);
    return true;
  } catch (error) {
    if (error instanceof ExcelWorkingResourceStoreError && error.message.includes('does not exist')) {
      return false;
    }
    throw error;
  }
}

/** Returns whether lstat can see a path, propagating errors other than ENOENT. */
async function existsAsPath(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (isFileNotFoundError(error)) return false;
    throw error;
  }
}

/** Ensures a regular file remains inside both its resource directory and workspace root. */
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
    throw new ExcelWorkingResourceStoreError(`${label} must remain inside workspaceRoot: ${filePath}.`);
  }
}

type RemovePath = (path: string) => Promise<void>;

/** @internal Filesystem cleanup helper; not re-exported from the infrastructure barrel. */
export async function removeTemporaryFile(
  filePath: string,
  remove: RemovePath = async (path) => unlink(path),
): Promise<void> {
  try {
    await remove(filePath);
  } catch (error) {
    if (isFileNotFoundError(error)) return;
    throw error;
  }
}

/** @internal Filesystem cleanup helper; not re-exported from the infrastructure barrel. */
export async function removeDirectoryIfPresent(
  directory: string,
  remove: RemovePath = async (path) => rm(path, { recursive: true, force: true }),
): Promise<void> {
  try {
    await remove(directory);
  } catch (error) {
    if (isFileNotFoundError(error)) return;
    throw error;
  }
}

/** Checks whether a resolved path is equal to or below a trusted root. */
function isPathWithin(rootPath: string, candidatePath: string): boolean {
  const candidateRelativePath = relative(rootPath, candidatePath);
  return (
    candidateRelativePath === '' ||
    (!isAbsolute(candidateRelativePath) &&
      candidateRelativePath !== '..' &&
      !candidateRelativePath.startsWith(`..${sep}`) &&
      !candidateRelativePath.startsWith('..\\') &&
      !candidateRelativePath.startsWith('../') &&
      !candidateRelativePath.includes(':'))
  );
}

/** Throws the original cancellation reason while preparation remains abortable. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new Error('Excel working resource operation was cancelled.');
}

/** Narrows an unknown parsed value to a JSON object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Identifies Node filesystem ENOENT errors across promise-based operations. */
function isFileNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
