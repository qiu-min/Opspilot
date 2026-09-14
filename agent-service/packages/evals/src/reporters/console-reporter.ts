import type { EvalReport } from '../core/eval-report.js';

/** Renders a compact human-readable report for local Eval runs. */
export class ConsoleReporter {
  /** Formats reports without performing IO, which keeps the reporter easy to test. */
  public render(reports: readonly EvalReport[]): string {
    const lines = ['OpsPilot Eval', ''];

    for (const report of reports) {
      lines.push(`${report.passed ? '✓' : '✗'} ${report.caseId}`);
      for (const score of report.scores) {
        lines.push(`  ${score.evaluator.padEnd(18)} ${score.score.toFixed(2)}`);
      }
      lines.push(`  ${'duration'.padEnd(18)} ${report.run.durationMs}ms`);
      if (report.run.error !== undefined) {
        lines.push(`  ${'error'.padEnd(18)} ${report.run.error.message}`);
      }
      lines.push('');
    }

    const passed = reports.filter((report) => report.passed).length;
    lines.push('Summary', `Passed: ${passed} / ${reports.length}`);
    return lines.join('\n');
  }

  /** Alias suitable for callers that think of rendering as producing a report. */
  public report(reports: readonly EvalReport[]): string {
    return this.render(reports);
  }

  /** Writes the rendered report to a caller-provided output function. */
  public write(
    reports: readonly EvalReport[],
    writeLine: (text: string) => void = console.log,
  ): void {
    writeLine(this.render(reports));
  }
}
