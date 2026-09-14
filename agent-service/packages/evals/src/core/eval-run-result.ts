/** The observable outcome of executing one EvalCase. */
export interface EvalRunResult<TActual = unknown> {
  readonly caseId: string;
  readonly status: 'completed' | 'failed' | 'error';
  readonly actual?: TActual;
  readonly durationMs: number;
  readonly error?: {
    readonly message: string;
  };
  readonly metadata?: Readonly<Record<string, unknown>>;
}
