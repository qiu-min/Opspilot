import type { EvalRunResult } from './eval-run-result.js';
import type { EvalScore } from './eval-score.js';

/** Scores one execution independently from the orchestration that produced it. */
export interface Evaluator<TExpected = unknown, TActual = unknown> {
  readonly name: string;

  evaluate(input: {
    readonly expected: TExpected | undefined;
    readonly actual: TActual | undefined;
    readonly run: EvalRunResult<TActual>;
  }): Promise<EvalScore>;
}
