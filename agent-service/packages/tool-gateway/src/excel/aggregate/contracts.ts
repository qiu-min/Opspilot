export type AggregateOperation = 'sum' | 'count' | 'average' | 'min' | 'max';

export interface AggregateMetric {
  readonly column: string;
  readonly operation: AggregateOperation;
  readonly alias?: string;
}

export interface AggregateDataInput {
  readonly filePath: string;
  readonly sheetName: string;
  readonly groupBy?: readonly string[];
  readonly metrics: readonly AggregateMetric[];
}

export type AggregateGroupValue = string | number | boolean | Date | null;

export type AggregateMetricValue = number | null;

export interface AggregateResultColumn {
  readonly name: string;
  readonly kind: 'group' | 'metric';
  readonly sourceColumn: string;
  readonly operation?: AggregateOperation;
}

export interface AggregateDataResult {
  readonly sheetName: string;
  readonly columns: readonly AggregateResultColumn[];
  readonly rows: readonly (readonly (AggregateGroupValue | AggregateMetricValue)[])[];
  readonly sourceRowCount: number;
  readonly resultRowCount: number;
}
