import { statSync } from 'node:fs';
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

    this.sharedStorageRoot = path.resolve(sharedStorageRoot);
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

    let fileStats: ReturnType<typeof statSync>;
    try {
      fileStats = statSync(filePath);
    } catch (cause) {
      throw new Error('Excel resource file does not exist.', { cause });
    }

    if (!fileStats.isFile()) {
      throw new Error('Excel resource path must point to a regular file.');
    }

    return { id: resource.id, filePath };
  }
}
