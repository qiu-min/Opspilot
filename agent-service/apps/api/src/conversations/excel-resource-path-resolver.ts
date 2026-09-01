import type { ExcelResource } from '@opspilot/application';

import type { ExcelResourceRequest } from './conversation.schemas.js';

/** Injection token for the runtime-provided Excel resource path resolver. */
export const EXCEL_RESOURCE_PATH_RESOLVER = Symbol('EXCEL_RESOURCE_PATH_RESOLVER');

/** Resolves an API resource descriptor into an Application ExcelResource. */
export interface ExcelResourcePathResolver {
  resolve(resource: ExcelResourceRequest): ExcelResource;
}
