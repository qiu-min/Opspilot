export type FilterValue = string | number | boolean | Date;

export type FilterOperator =
  'equals' | 'notEquals' | 'greaterThan' | 'lessThan' | 'contains' | 'isEmpty' | 'isNotEmpty';

export interface FilterCondition {
  readonly column: string;
  readonly operator: FilterOperator;
  readonly value?: FilterValue;
}

export type FilterLogic = 'all' | 'any';

export interface FilterDataInput {
  readonly filePath: string;
  readonly sheetName: string;
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
