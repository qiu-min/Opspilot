import type { EvalRunResult } from './eval-run-result.js';
import type { EvalScore } from './eval-score.js';

/** The complete report for one case, including execution and all evaluator scores. */
export interface EvalReport<TActual = unknown> {
  readonly caseId: string;
  readonly caseName: string;
  readonly run: EvalRunResult<TActual>;
  readonly scores: readonly EvalScore[];
  readonly passed: boolean;
}
