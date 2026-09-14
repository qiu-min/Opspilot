import type { EvalCase } from './eval-case.js';
import type { EvalRunResult } from './eval-run-result.js';

/** Executes one case and returns an Eval-specific result without scoring it. */
export interface EvalExecutor<TInput = unknown, TActual = unknown> {
  execute(evalCase: EvalCase<TInput, unknown>): Promise<EvalRunResult<TActual>>;
}
