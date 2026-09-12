import type { ExcelResource } from '../../tools/excel-resource.js';

/** Durable, minimal inputs needed to reconstruct one Turn execution. */
export interface TurnExecutionContext {
  readonly version: 1;
  readonly excelResource?: ExcelResource;
}
