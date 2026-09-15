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

/** Identifies one retryable mutation by the Agent Runtime Tool call that owns it. */
export interface ExcelWorkingMutationRequest extends ExcelWorkingResourceRequest {
  readonly mutationId: string;
}

/** Filesystem-independent details needed while a caller mutates a private staged workbook. */
export interface ExcelWorkingMutationContext {
  readonly stagingPath: string;
  readonly baseRevision: number;
  readonly targetRevision: number;
}

/** Durable result for one committed or replayed mutation. */
export interface ExcelWorkingMutationResult {
  readonly resource: ExcelWorkingResource;
  readonly receipt: unknown;
  readonly replayed: boolean;
}

/** Persisted receipt metadata returned by the resource store when a callId was committed. */
export interface ExcelWorkingMutationReceiptRecord {
  readonly revision: number;
  readonly receipt: unknown;
}
