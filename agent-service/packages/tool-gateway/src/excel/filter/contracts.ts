import type {
  ExcelPredicate,
  ExcelPredicateLogic,
  ExcelPredicateOperator,
  ExcelPredicateValue,
} from '../shared/query/predicate-contracts.js';

export type FilterValue = ExcelPredicateValue;
export type FilterOperator = ExcelPredicateOperator;
export type FilterCondition = ExcelPredicate;
export type FilterLogic = ExcelPredicateLogic;

export interface FilterDataInput {
  readonly filePath: string;
  readonly sheetName: string;
  readonly range?: string;
  readonly conditions: readonly FilterCondition[];
  readonly logic?: FilterLogic;
}

export interface FilterRowRange {
  readonly startRow: number;
  readonly endRow: number;
}

export interface FilterDataResult {
  readonly sheetName: string;
  readonly sourceRowCount: number;
  readonly matchedRowCount: number;
  readonly matchedRanges: readonly FilterRowRange[];
}
