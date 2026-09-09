import type { ExcelResource } from '../tools/excel-resource.js';

/** Durable, minimal inputs needed to reconstruct one Turn execution. */
export interface TurnExecutionContext {
  readonly version: 1;
  readonly excelResource?: ExcelResource;
}

/** Persistence boundary for Turn inputs that are not part of the Domain Turn. */
export interface TurnExecutionContextStore {
  save(turnId: string, context: TurnExecutionContext): void;
  load(turnId: string): TurnExecutionContext | null;
}
