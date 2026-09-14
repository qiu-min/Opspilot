import { describe, expect, it } from 'vitest';

import { RunCompletedEvaluator } from '../src/evaluators/run-completed-evaluator.js';

describe('RunCompletedEvaluator', () => {
  const evaluator = new RunCompletedEvaluator();

  it.each([
    ['completed', true, 1],
    ['failed', false, 0],
    ['error', false, 0],
  ] as const)('maps %s to the expected score', async (status, passed, score) => {
    const result = await evaluator.evaluate({
      expected: undefined,
      actual: undefined,
      run: { caseId: 'case-1', status, durationMs: 1 },
    });

    expect(result).toMatchObject({ evaluator: 'run_completed', passed, score });
  });
});
