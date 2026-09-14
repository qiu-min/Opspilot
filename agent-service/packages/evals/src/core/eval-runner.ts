import type { EvalCase } from './eval-case.js';
import type { EvalExecutor } from './eval-executor.js';
import type { Evaluator } from './evaluator.js';
import type { EvalReport } from './eval-report.js';
import type { EvalRunResult } from './eval-run-result.js';
import type { EvalScore } from './eval-score.js';

export interface EvalRunnerOptions<TInput, TExpected, TActual> {
  readonly executor: EvalExecutor<TInput, TActual>;
  readonly evaluators: readonly Evaluator<TExpected, TActual>[];
}

/** Orchestrates case execution followed by sequential evaluator aggregation. */
export class EvalRunner<TInput = unknown, TExpected = unknown, TActual = unknown> {
  private readonly executor: EvalExecutor<TInput, TActual>;
  private readonly evaluators: readonly Evaluator<TExpected, TActual>[];

  /** Creates a runner with one executor and zero or more independently evaluated scores. */
  public constructor(options: EvalRunnerOptions<TInput, TExpected, TActual>) {
    this.executor = options.executor;
    this.evaluators = [...options.evaluators];
  }

  /** Executes one case and converts an executor throw into a stable error result. */
  public async run(evalCase: EvalCase<TInput, TExpected>): Promise<EvalReport<TActual>> {
    const run = await this.executeCase(evalCase);
    const scores: EvalScore[] = [];

    for (const evaluator of this.evaluators) {
      scores.push(await this.evaluateCase(evaluator, evalCase, run));
    }

    return {
      caseId: evalCase.id,
      caseName: evalCase.name,
      run,
      scores,
      passed: scores.every((score) => score.passed),
    };
  }

  /** Runs cases in input order so one failed case cannot prevent later cases from running. */
  public async runAll(
    evalCases: readonly EvalCase<TInput, TExpected>[],
  ): Promise<readonly EvalReport<TActual>[]> {
    const reports: EvalReport<TActual>[] = [];
    for (const evalCase of evalCases) {
      reports.push(await this.run(evalCase));
    }
    return reports;
  }

  private async executeCase(
    evalCase: EvalCase<TInput, TExpected>,
  ): Promise<EvalRunResult<TActual>> {
    const startedAt = Date.now();
    try {
      return await this.executor.execute(evalCase);
    } catch (error: unknown) {
      return {
        caseId: evalCase.id,
        status: 'error',
        durationMs: elapsedMilliseconds(startedAt),
        error: { message: errorMessage(error) },
      };
    }
  }

  private async evaluateCase(
    evaluator: Evaluator<TExpected, TActual>,
    evalCase: EvalCase<TInput, TExpected>,
    run: EvalRunResult<TActual>,
  ): Promise<EvalScore> {
    try {
      return await evaluator.evaluate({
        expected: evalCase.expected,
        actual: run.actual,
        run,
      });
    } catch (error: unknown) {
      return {
        evaluator: evaluator.name,
        score: 0,
        passed: false,
        reason: `Evaluator failed: ${errorMessage(error)}`,
        details: { kind: 'evaluator_error' },
      };
    }
  }
}

/** Converts an unknown thrown value into a deterministic human-readable message. */
function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return String(error);
}

/** Keeps duration non-negative even when the system clock changes during execution. */
function elapsedMilliseconds(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}
