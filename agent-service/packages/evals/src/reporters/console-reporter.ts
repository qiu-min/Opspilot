import type { EvalReport } from '../core/eval-report.js';
import type { EvalScore } from '../core/eval-score.js';

/** Renders a compact human-readable report for local Eval runs. */
export class ConsoleReporter {
  /** Formats reports without performing IO, which keeps the reporter easy to test. */
  public render(reports: readonly EvalReport[]): string {
    const lines = ['OpsPilot Eval', ''];

    for (const report of reports) {
      lines.push(`${report.passed ? '✓' : '✗'} ${report.caseId}`);
      for (const score of report.scores) {
        lines.push(`  ${score.evaluator.padEnd(18)} ${score.score.toFixed(2)}`);
        const traceMetrics = renderTraceMetrics(score);
        if (traceMetrics !== undefined) lines.push(`  ${'trace metrics'.padEnd(18)} ${traceMetrics}`);
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

/** Adds a compact view of Trace metrics while leaving the full JSON details intact. */
function renderTraceMetrics(score: EvalScore): string | undefined {
  if (score.evaluator !== 'trace_behavior' || score.details === undefined) return undefined;
  const details = score.details;
  if (
    !isNumber(details.modelCalls) ||
    !isNumber(details.toolCalls) ||
    !isNumber(details.toolErrors) ||
    !isNumber(details.retries) ||
    !isNumber(details.totalTokens) ||
    (details.durationMs !== null && !isNumber(details.durationMs))
  ) {
    return undefined;
  }
  return [
    `modelCalls=${details.modelCalls}`,
    `toolCalls=${details.toolCalls}`,
    `toolErrors=${details.toolErrors}`,
    `retries=${details.retries}`,
    `totalTokens=${details.totalTokens}`,
    `durationMs=${details.durationMs === null ? 'null' : details.durationMs}`,
  ].join(' ');
}

/** Checks a reporter detail value before formatting it as a numeric metric. */
function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
