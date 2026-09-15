import type { SessionResourceRef } from '@opspilot/domain';
import type { ExcelResource } from './excel-resource.js';

/** Application-specific context available while an Application Tool executes. */
export interface ToolExecutionContext {
  readonly turnId: string;
  readonly sessionId: string;
  readonly excelResources: readonly ExcelResource[];
  readonly excelResourceRefs: readonly SessionResourceRef[];
  readonly activeExcelResourceId: string | null;
}

/** Backwards-compatible name for the Application Tool execution context. */
export type ToolContext = ToolExecutionContext;
