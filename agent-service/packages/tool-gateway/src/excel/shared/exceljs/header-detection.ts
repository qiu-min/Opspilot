import type { Worksheet } from 'exceljs';

import { parseCellRange, type CellRange } from '../cell-reference.js';
import {
  hasNonEmptyCellValue,
  headerText,
  parseExcelCellValue,
  type ParsedExcelCellValue,
} from './cell-value.js';
import { throwIfAborted } from './workbook-io.js';

const HEADER_DETECTION_CONFIG = {
  maxCandidateRows: 20,
  maxDataScanRows: 50,
  maxDataSampleRows: 20,
  continuityRowTarget: 5,
  minimumHeaderCells: 2,
  singleColumnPenalty: 0.12,
  candidateScoreThreshold: 0.47,
  densityWeight: 0.2,
  textRatioWeight: 0.2,
  uniquenessWeight: 0.15,
  continuityWeight: 0.2,
  typeBoundaryWeight: 0.25,
  confidenceBestWeight: 0.7,
  confidenceMarginWeight: 0.3,
  confidenceMarginScale: 0.5,
  singleCellPenalty: 0.28,
  nonTextPenalty: 0.08,
  lowDensityPenaltyWeight: 0.13,
  lowDensityThreshold: 0.5,
  mergedTitlePenalty: 0.12,
} as const;

type HeaderCellType =
  'empty' | 'string' | 'number' | 'boolean' | 'date' | 'formula' | 'error' | 'other';

interface HeaderCellSnapshot {
  readonly nonEmpty: boolean;
  readonly text: string | null;
  readonly type: HeaderCellType;
}

interface RowSnapshot {
  readonly cells: readonly HeaderCellSnapshot[];
  readonly nonEmptyCount: number;
}

interface HeaderCandidateScore {
  readonly row: number;
  readonly score: number;
  readonly densityScore: number;
  readonly textRatioScore: number;
  readonly uniquenessScore: number;
  readonly dataContinuityScore: number;
  readonly typeBoundaryScore: number;
  readonly sparsePenalty: number;
  readonly nonTextPenalty: number;
  readonly mergedTitlePenalty: number;
}

export interface HeaderDetectionResult {
  readonly headerRow: number | null;
  readonly confidence: number;
}

/** Detects the most likely tabular header row from bounded worksheet samples. */
export function detectHeaderRow(
  worksheet: Worksheet,
  usedRange: CellRange | undefined,
  signal?: AbortSignal,
): HeaderDetectionResult {
  throwIfAborted(signal, 'detectHeaderRow');
  if (usedRange === undefined) {
    return { headerRow: null, confidence: 0 };
  }

  let bestCandidate: HeaderCandidateScore | undefined;
  let secondBestCandidate: HeaderCandidateScore | undefined;
  const lastCandidateRow = Math.min(
    usedRange.start.row + HEADER_DETECTION_CONFIG.maxCandidateRows - 1,
    usedRange.end.row,
  );

  for (let row = usedRange.start.row; row <= lastCandidateRow; row += 1) {
    throwIfAborted(signal, 'detectHeaderRow');
    const candidate = readRowSnapshot(worksheet, row, usedRange);
    if (candidate.nonEmptyCount === 0) {
      continue;
    }

    const dataRows = sampleDataRows(worksheet, row, usedRange, signal);
    const score = scoreHeaderCandidate(worksheet, usedRange, row, candidate, dataRows);
    if (bestCandidate === undefined || score.score > bestCandidate.score) {
      secondBestCandidate = bestCandidate;
      bestCandidate = score;
    } else if (secondBestCandidate === undefined || score.score > secondBestCandidate.score) {
      secondBestCandidate = score;
    }
  }

  const confidence = calculateConfidence(bestCandidate, secondBestCandidate);
  return {
    headerRow:
      bestCandidate !== undefined &&
      bestCandidate.score >= HEADER_DETECTION_CONFIG.candidateScoreThreshold
        ? bestCandidate.row
        : null,
    confidence,
  };
}

/** Reads one bounded worksheet row without materializing worksheet data. */
function readRowSnapshot(worksheet: Worksheet, row: number, usedRange: CellRange): RowSnapshot {
  const cells: HeaderCellSnapshot[] = [];
  let nonEmptyCount = 0;

  for (let column = usedRange.start.column; column <= usedRange.end.column; column += 1) {
    const value = worksheet.findCell(row, column)?.value;
    const nonEmpty = hasNonEmptyCellValue(value);
    if (nonEmpty) {
      nonEmptyCount += 1;
    }

    cells.push({
      nonEmpty,
      text: nonEmpty ? headerText(value) : null,
      type: classifyCellValue(value),
    });
  }

  return { cells, nonEmptyCount };
}

/** Samples a bounded number of non-empty rows below one candidate. */
function sampleDataRows(
  worksheet: Worksheet,
  candidateRow: number,
  usedRange: CellRange,
  signal: AbortSignal | undefined,
): readonly RowSnapshot[] {
  const rows: RowSnapshot[] = [];
  const lastScanRow = Math.min(
    candidateRow + HEADER_DETECTION_CONFIG.maxDataScanRows,
    usedRange.end.row,
  );
  for (
    let row = candidateRow + 1;
    row <= lastScanRow && rows.length < HEADER_DETECTION_CONFIG.maxDataSampleRows;
    row += 1
  ) {
    throwIfAborted(signal, 'detectHeaderRow');
    const snapshot = readRowSnapshot(worksheet, row, usedRange);
    if (snapshot.nonEmptyCount > 0) {
      rows.push(snapshot);
    }
  }

  return rows;
}

/** Combines candidate quality with the separation from the runner-up candidate. */
function calculateConfidence(
  bestCandidate: HeaderCandidateScore | undefined,
  secondBestCandidate: HeaderCandidateScore | undefined,
): number {
  if (bestCandidate === undefined) {
    return 0;
  }

  if (secondBestCandidate === undefined) {
    return bestCandidate.score;
  }

  const margin = Math.max(0, bestCandidate.score - secondBestCandidate.score);
  const normalizedMargin = clamp01(margin / HEADER_DETECTION_CONFIG.confidenceMarginScale);
  return clamp01(
    bestCandidate.score * HEADER_DETECTION_CONFIG.confidenceBestWeight +
      normalizedMargin * HEADER_DETECTION_CONFIG.confidenceMarginWeight,
  );
}

/** Calculates the explainable score for one candidate and its downstream sample. */
function scoreHeaderCandidate(
  worksheet: Worksheet,
  usedRange: CellRange,
  row: number,
  candidate: RowSnapshot,
  dataRows: readonly RowSnapshot[],
): HeaderCandidateScore {
  const width = usedRange.end.column - usedRange.start.column + 1;
  const densityScore = candidate.nonEmptyCount / width;
  const textRatioScore = calculateTextRatio(candidate);
  const uniquenessScore = calculateUniqueness(candidate);
  const dataContinuityScore = calculateDataContinuity(dataRows, width);
  const typeBoundaryScore = calculateTypeBoundary(candidate, dataRows);
  const sparsePenalty = calculateSparsePenalty(candidate.nonEmptyCount, densityScore, width);
  const nonTextPenalty = textRatioScore === 0 ? HEADER_DETECTION_CONFIG.nonTextPenalty : 0;
  const mergedTitlePenalty = hasHorizontalMergeOnRow(worksheet, row, usedRange)
    ? HEADER_DETECTION_CONFIG.mergedTitlePenalty
    : 0;
  const score = clamp01(
    densityScore * HEADER_DETECTION_CONFIG.densityWeight +
      textRatioScore * HEADER_DETECTION_CONFIG.textRatioWeight +
      uniquenessScore * HEADER_DETECTION_CONFIG.uniquenessWeight +
      dataContinuityScore * HEADER_DETECTION_CONFIG.continuityWeight +
      typeBoundaryScore * HEADER_DETECTION_CONFIG.typeBoundaryWeight -
      sparsePenalty -
      nonTextPenalty -
      mergedTitlePenalty,
  );

  return {
    row,
    score,
    densityScore,
    textRatioScore,
    uniquenessScore,
    dataContinuityScore,
    typeBoundaryScore,
    sparsePenalty,
    nonTextPenalty,
    mergedTitlePenalty,
  };
}

/** Scores how densely the candidate populates the used columns. */
function calculateTextRatio(candidate: RowSnapshot): number {
  if (candidate.nonEmptyCount === 0) {
    return 0;
  }

  return (
    candidate.cells.filter((cell) => cell.nonEmpty && cell.type === 'string').length /
    candidate.nonEmptyCount
  );
}

/** Scores the proportion of unique non-empty header labels. */
function calculateUniqueness(candidate: RowSnapshot): number {
  const labels = candidate.cells
    .filter((cell) => cell.nonEmpty)
    .map((cell) => cell.text?.trim() ?? '');
  if (labels.length === 0) {
    return 0;
  }

  return new Set(labels).size / labels.length;
}

/** Scores the amount and shape of bounded downstream data. */
function calculateDataContinuity(dataRows: readonly RowSnapshot[], width: number): number {
  if (dataRows.length === 0) {
    return 0;
  }

  const rowCountScore = Math.min(dataRows.length / HEADER_DETECTION_CONFIG.continuityRowTarget, 1);
  const averageDensity =
    dataRows.reduce((total, row) => total + row.nonEmptyCount / width, 0) / dataRows.length;

  return clamp01(rowCountScore * 0.7 + averageDensity * 0.3);
}

/** Scores stable non-string types below string-like header cells. */
function calculateTypeBoundary(candidate: RowSnapshot, dataRows: readonly RowSnapshot[]): number {
  const headerIndexes = candidate.cells.flatMap((cell, index) =>
    cell.nonEmpty && cell.type === 'string' ? [index] : [],
  );
  if (headerIndexes.length === 0) {
    return 0;
  }

  let boundaryCount = 0;
  for (const index of headerIndexes) {
    const dataTypes = new Set<HeaderCellType>();
    for (const row of dataRows) {
      const cell = row.cells[index];
      if (cell?.nonEmpty) {
        dataTypes.add(cell.type);
      }
    }

    if (dataTypes.size === 1 && !dataTypes.has('string')) {
      boundaryCount += 1;
    }
  }

  return boundaryCount / headerIndexes.length;
}

/** Penalizes one-cell and sparse candidates without excluding them outright. */
function calculateSparsePenalty(nonEmptyCount: number, density: number, width: number): number {
  let penalty =
    nonEmptyCount < HEADER_DETECTION_CONFIG.minimumHeaderCells
      ? width === 1
        ? HEADER_DETECTION_CONFIG.singleColumnPenalty
        : HEADER_DETECTION_CONFIG.singleCellPenalty
      : 0;

  if (density < HEADER_DETECTION_CONFIG.lowDensityThreshold) {
    penalty +=
      ((HEADER_DETECTION_CONFIG.lowDensityThreshold - density) /
        HEADER_DETECTION_CONFIG.lowDensityThreshold) *
      HEADER_DETECTION_CONFIG.lowDensityPenaltyWeight;
  }

  return penalty;
}

/** Detects simple horizontal merged rows exposed by ExcelJS worksheet metadata. */
function hasHorizontalMergeOnRow(worksheet: Worksheet, row: number, usedRange: CellRange): boolean {
  return worksheet.model.merges.some((reference) => {
    const mergedRange = parseCellRange(reference);
    return (
      mergedRange.start.row === row &&
      mergedRange.end.row === row &&
      mergedRange.start.column < mergedRange.end.column &&
      mergedRange.end.column >= usedRange.start.column &&
      mergedRange.start.column <= usedRange.end.column
    );
  });
}

/** Classifies values through the shared ExcelJS cell-value parser. */
function classifyCellValue(value: unknown): HeaderCellType {
  const parsed = parseExcelCellValue(value);
  if (parsed.kind === 'empty') {
    return 'empty';
  }

  if (parsed.kind === 'formula') {
    return 'formula';
  }

  if (parsed.kind === 'value') {
    return classifyParsedScalar(parsed);
  }

  if (isTextLikeObject(value)) {
    return 'string';
  }

  if (isErrorObject(value)) {
    return 'error';
  }

  return 'other';
}

/** Maps the shared parser's scalar value to a comparable data type. */
function classifyParsedScalar(
  parsed: Extract<ParsedExcelCellValue, { kind: 'value' }>,
): HeaderCellType {
  if (parsed.value instanceof Date) {
    return 'date';
  }

  if (typeof parsed.value === 'string') {
    return 'string';
  }

  if (typeof parsed.value === 'number') {
    return 'number';
  }

  if (typeof parsed.value === 'boolean') {
    return 'boolean';
  }

  return 'other';
}

/** Checks whether an unsupported ExcelJS object is text-like. */
function isTextLikeObject(value: unknown): boolean {
  return isRecord(value) && (typeof value.text === 'string' || Array.isArray(value.richText));
}

/** Checks whether an unsupported ExcelJS object contains an Excel error. */
function isErrorObject(value: unknown): boolean {
  return isRecord(value) && typeof value.error === 'string';
}

/** Narrows an unknown value to a non-null record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Keeps confidence in the public 0..1 interval. */
function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
