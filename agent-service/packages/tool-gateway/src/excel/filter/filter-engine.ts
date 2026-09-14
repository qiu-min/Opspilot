import type { ParsedExcelCellValue } from '../shared/exceljs/cell-value.js';
import {
  evaluatePredicate,
  evaluatePredicates,
  type PredicateValueContext,
} from '../shared/query/predicate-engine.js';
import type {
  FilterCondition,
  FilterDataResult,
  FilterLogic,
  FilterRowRange,
} from './contracts.js';

/** Compatibility context for callers that used the former filter evaluator API. */
export type FilterValueContext = PredicateValueContext;

/** Compatibility resolution shape translated into the shared predicate contract. */
export interface ResolvedFilterCondition {
  readonly condition: FilterCondition;
  readonly columnIndex: number;
}

/** Evaluates one filter condition through the shared predicate evaluator. */
export function matchesFilterCondition(
  value: ParsedExcelCellValue | undefined,
  condition: FilterCondition,
  context: FilterValueContext,
): boolean {
  return evaluatePredicate(value, condition, context);
}

/** Evaluates filter conditions through the shared predicate evaluator. */
export function matchesConditions(
  values: ReadonlyMap<number, ParsedExcelCellValue>,
  conditions: readonly ResolvedFilterCondition[],
  logic: FilterLogic,
  contextFor: (condition: ResolvedFilterCondition) => FilterValueContext,
): boolean {
  return evaluatePredicates(
    values,
    conditions.map(({ condition, columnIndex }) => ({ predicate: condition, columnIndex })),
    logic,
    (resolved) => contextFor({ condition: resolved.predicate, columnIndex: resolved.columnIndex }),
  );
}

export interface MatchedRangeAccumulator {
  readonly ranges: FilterRowRange[];
  matchedRowCount: number;
  currentRange: FilterRowRange | null;
}

/** Creates the streaming accumulator used to compress matched row numbers into ranges. */
export function createMatchedRangeAccumulator(): MatchedRangeAccumulator {
  return { ranges: [], matchedRowCount: 0, currentRange: null };
}

/** Records one matched row without materializing a second row-number collection. */
export function recordMatchedRow(accumulator: MatchedRangeAccumulator, row: number): void {
  accumulator.matchedRowCount += 1;

  if (accumulator.currentRange === null) {
    accumulator.currentRange = { startRow: row, endRow: row };
    return;
  }

  if (accumulator.currentRange.endRow + 1 === row) {
    accumulator.currentRange = { ...accumulator.currentRange, endRow: row };
    return;
  }

  accumulator.ranges.push(accumulator.currentRange);
  accumulator.currentRange = { startRow: row, endRow: row };
}

/** Finalizes the current match range and returns a stable read-only range list. */
export function finalizeMatchedRanges(
  accumulator: MatchedRangeAccumulator,
): FilterDataResult['matchedRanges'] {
  if (accumulator.currentRange !== null) {
    accumulator.ranges.push(accumulator.currentRange);
    accumulator.currentRange = null;
  }
  return accumulator.ranges.slice();
}
