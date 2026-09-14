import { describe, expect, it, vi } from 'vitest';

import { EvalRunner } from '../src/core/eval-runner.js';
import type { EvalExecutor } from '../src/core/eval-executor.js';
import type { EvalCase } from '../src/core/eval-case.js';
import type { EvalRunResult } from '../src/core/eval-run-result.js';
import type { Evaluator } from '../src/core/evaluator.js';

interface Actual {
  readonly value: string;
}

const evalCase: EvalCase<string, string> = {
  id: 'case-1',
  name: 'Case 1',
  input: 'hello',
  expected: 'world',
};

function completedResult(caseId: string): EvalRunResult<Actual> {
  return { caseId, status: 'completed', actual: { value: 'ok' }, durationMs: 3 };
}

describe('EvalRunner', () => {
  it('executes a case and calls its evaluator with the execution result', async () => {
    const executor: EvalExecutor<string, Actual> = {
      execute: vi.fn(async (currentCase) => completedResult(currentCase.id)),
    };
    const evaluate = vi.fn(async () => ({ evaluator: 'test', score: 1, passed: true }));
    const runner = new EvalRunner({
      executor,
      evaluators: [{ name: 'test', evaluate } satisfies Evaluator<string, Actual>],
    });

    const report = await runner.run(evalCase);

    expect(executor.execute).toHaveBeenCalledWith(evalCase);
    expect(evaluate).toHaveBeenCalledWith({
      expected: 'world',
      actual: { value: 'ok' },
      run: completedResult('case-1'),
    });
    expect(report.passed).toBe(true);
  });

  it('aggregates multiple evaluator scores and fails when one evaluator fails', async () => {
    const runner = new EvalRunner({
      executor: { execute: async (currentCase) => completedResult(currentCase.id) },
      evaluators: [
        {
          name: 'first',
          evaluate: async () => ({ evaluator: 'first', score: 1, passed: true }),
        },
        {
          name: 'second',
          evaluate: async () => ({
            evaluator: 'second',
            score: 0,
            passed: false,
            reason: 'not equal',
          }),
        },
      ],
    });

    const report = await runner.run(evalCase);

    expect(report.scores).toHaveLength(2);
    expect(report.passed).toBe(false);
  });

  it('converts an executor throw to an error result and continues later cases', async () => {
    const executed: string[] = [];
    const runner = new EvalRunner<string, unknown, Actual>({
      executor: {
        execute: async (currentCase) => {
          executed.push(currentCase.id);
          if (currentCase.id === 'case-1') throw new Error('agent unavailable');
          return completedResult(currentCase.id);
        },
      },
      evaluators: [
        {
          name: 'completed',
          evaluate: async ({ run }) => ({
            evaluator: 'completed',
            score: run.status === 'completed' ? 1 : 0,
            passed: run.status === 'completed',
          }),
        },
      ],
    });

    const reports = await runner.runAll([evalCase, { ...evalCase, id: 'case-2' }]);

    expect(executed).toEqual(['case-1', 'case-2']);
    expect(reports[0]?.run).toMatchObject({
      caseId: 'case-1',
      status: 'error',
      error: { message: 'agent unavailable' },
    });
    expect(reports[0]?.passed).toBe(false);
    expect(reports[1]?.passed).toBe(true);
  });
});
