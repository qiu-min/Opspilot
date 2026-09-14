import type { Evaluator } from '../core/evaluator.js';
import type { EvalScore } from '../core/eval-score.js';
import type { EvalRunResult } from '../core/eval-run-result.js';

/** Smoke evaluator that verifies the Application execution reached completion. */
export class RunCompletedEvaluator<TActual = unknown> implements Evaluator<unknown, TActual> {
  public readonly name = 'run_completed';

  /** Returns a binary score based only on the normalized run status. */
  public async evaluate(input: {
    readonly expected: unknown;
    readonly actual: TActual | undefined;
    readonly run: EvalRunResult<TActual>;
  }): Promise<EvalScore> {
    if (input.run.status === 'completed') {
      return {
        evaluator: this.name,
        score: 1,
        passed: true,
      };
    }

    return {
      evaluator: this.name,
      score: 0,
      passed: false,
      reason: input.run.error?.message ?? `Run status was ${input.run.status}.`,
    };
  }
}
