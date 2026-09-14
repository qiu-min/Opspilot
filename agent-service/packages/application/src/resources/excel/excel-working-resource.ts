/** Describes one Session-owned mutable Excel copy and its immutable source. */
export interface ExcelWorkingResource {
  readonly sessionId: string;
  readonly sourceResourceId: string;
  readonly sourcePath: string;
  readonly workingPath: string;
  readonly revision: number;
}

/** Identifies an Excel source while resolving its Session-scoped working state. */
export interface ExcelWorkingResourceRequest {
  readonly sessionId: string;
  readonly sourceResourceId: string;
  readonly sourcePath: string;
  readonly signal?: AbortSignal;
}
