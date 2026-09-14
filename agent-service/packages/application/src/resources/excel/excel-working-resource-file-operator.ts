/** Filesystem-facing operations needed by the Application copy-on-write coordinator. */
export interface ExcelWorkingResourceFileOperator {
  /** Returns the deterministic workspace path for one Session/resource identity. */
  getWorkingPath(sessionId: string, sourceResourceId: string): string;

  /** Copies an immutable source into a not-yet-created working copy. */
  copySourceToWorking(sourcePath: string, workingPath: string, signal?: AbortSignal): Promise<void>;
}
