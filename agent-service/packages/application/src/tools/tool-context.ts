import type { ExcelResource } from './excel-resource.js';

/** Application-specific context available while an Application Tool executes. */
export interface ToolContext {
  readonly sessionId: string;
  readonly excelResource: ExcelResource;
}
