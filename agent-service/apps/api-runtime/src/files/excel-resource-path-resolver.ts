import { realpathSync, statSync } from 'node:fs';
import * as path from 'node:path';

import type { ExcelResource } from '@opspilot/application';
import type { ExcelResourcePathResolver, ExcelResourceRequest } from '@opspilot/api';

/** Resolves shared-storage-relative Excel resources without reading their contents. */
export class FileSystemExcelResourcePathResolver implements ExcelResourcePathResolver {
  private readonly sharedStorageRoot: string;

  public constructor(sharedStorageRoot: string) {
    if (sharedStorageRoot.trim().length === 0) {
      throw new Error('sharedStorageRoot is required.');
    }

    const configuredRoot = path.resolve(sharedStorageRoot);
    try {
      this.sharedStorageRoot = realpathSync(configuredRoot);
    } catch (cause) {
      throw new Error('sharedStorageRoot does not exist or cannot be accessed.', { cause });
    }
  }

  /** Resolves and verifies one regular file under the configured shared storage root. */
  public resolve(resource: ExcelResourceRequest): ExcelResource {
    const storagePath = resource.storagePath.trim();
    if (storagePath.length === 0) {
      throw new Error('Excel resource storagePath is required.');
    }

    if (
      path.isAbsolute(storagePath) ||
      path.win32.isAbsolute(storagePath) ||
      storagePath.split(/[\\/]+/).some((segment) => segment === '..')
    ) {
      throw new Error('Excel resource storagePath must remain within sharedStorageRoot.');
    }

    const filePath = path.resolve(this.sharedStorageRoot, storagePath);
    const relativePath = path.relative(this.sharedStorageRoot, filePath);
    if (
      relativePath === '..' ||
      relativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePath)
    ) {
      throw new Error('Excel resource storagePath must remain within sharedStorageRoot.');
    }

    let realFilePath: string;
    try {
      realFilePath = realpathSync(filePath);
    } catch (cause) {
      if (isFileNotFoundError(cause)) {
        throw new Error('Excel resource file does not exist.', { cause });
      }

      throw new Error('Unable to access Excel resource file.', { cause });
    }

    const realRelativePath = path.relative(this.sharedStorageRoot, realFilePath);
    if (
      realRelativePath === '..' ||
      realRelativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(realRelativePath)
    ) {
      throw new Error('Excel resource storagePath must remain within sharedStorageRoot.');
    }

    const fileStats = statSync(realFilePath);
    if (!fileStats.isFile()) {
      throw new Error('Excel resource path must point to a regular file.');
    }

    return { id: resource.id, filePath: realFilePath };
  }
}

function isFileNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
