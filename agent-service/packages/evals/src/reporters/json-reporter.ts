import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { EvalReport } from '../core/eval-report.js';
import type { EvalScore } from '../core/eval-score.js';

interface JsonCaseReport {
  readonly caseId: string;
  readonly caseName: string;
  readonly passed: boolean;
  readonly scores: readonly EvalScore[];
  readonly run: {
    readonly status: EvalReport['run']['status'];
    readonly durationMs: number;
    readonly error?: EvalReport['run']['error'];
  };
}

interface JsonEvalReport {
  readonly cases: readonly JsonCaseReport[];
}

/** Serializes stable, machine-readable case summaries without embedding actual Agent transcripts. */
export class JsonReporter {
  /** Creates deterministic pretty JSON with a stable top-level `cases` field. */
  public render(reports: readonly EvalReport[]): string {
    const document: JsonEvalReport = {
      cases: reports.map((report): JsonCaseReport => ({
        caseId: report.caseId,
        caseName: report.caseName,
        passed: report.passed,
        scores: report.scores,
        run: {
          status: report.run.status,
          durationMs: report.run.durationMs,
          ...(report.run.error === undefined ? {} : { error: report.run.error }),
        },
      })),
    };
    return JSON.stringify(document, null, 2);
  }

  /** Alias suitable for callers that think of serialization as producing a report. */
  public report(reports: readonly EvalReport[]): string {
    return this.render(reports);
  }

  /** Writes one report file, creating its parent directory when needed. */
  public async writeFile(filePath: string, reports: readonly EvalReport[]): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, `${this.render(reports)}\n`, 'utf8');
  }
}
