import { describe, expect, it } from 'vitest';

import { ConsoleReporter } from '../src/reporters/console-reporter.js';
import { JsonReporter } from '../src/reporters/json-reporter.js';

describe('reporters', () => {
  const reports = [
    {
      caseId: 'smoke-agent-turn',
      caseName: 'Smoke Agent Turn',
      run: { caseId: 'smoke-agent-turn', status: 'completed' as const, durationMs: 12 },
      scores: [{ evaluator: 'run_completed', score: 1, passed: true }],
      passed: true,
    },
  ];

  it('renders the compact console summary', () => {
    const output = new ConsoleReporter().render(reports);

    expect(output).toContain('OpsPilot Eval');
    expect(output).toContain('✓ smoke-agent-turn');
    expect(output).toContain('Passed: 1 / 1');
  });

  it('serializes a stable machine-readable cases structure', () => {
    const output = JSON.parse(new JsonReporter().render(reports)) as {
      cases: Array<{
        caseId: string;
        passed: boolean;
        scores: Array<{ evaluator: string; score: number; passed: boolean }>;
      }>;
    };

    expect(output).toEqual({
      cases: [
        {
          caseId: 'smoke-agent-turn',
          caseName: 'Smoke Agent Turn',
          passed: true,
          scores: [{ evaluator: 'run_completed', score: 1, passed: true }],
          run: { status: 'completed', durationMs: 12 },
        },
      ],
    });
  });
});
