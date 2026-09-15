import type {
  AggregateGroupValue,
  AggregateMetricValue,
  AggregateResultColumn,
  FilterRowRange,
} from '@opspilot/tool-gateway';

/** JSON-friendly Excel cell value stored by the bounded read_range Application Tool. */
export type ReadRangeToolCellValue = string | number | boolean | null;

/** Bounded, rectangular range output returned by read_range and persisted in the Session. */
export interface ReadRangeToolDetails {
  readonly sheetName: string;
  readonly range: string;
  readonly rowCount: number;
  readonly columnCount: number;
  readonly cellCount: number;
  readonly values: readonly (readonly ReadRangeToolCellValue[])[];
  /** Cells whose details or model-visible string representation was truncated. */
  readonly truncatedCellValueCount: number;
}

/** Bounded aggregate output returned by the Application Tool and persisted in the Session. */
export interface AggregateDataToolDetails {
  readonly sheetName: string;
  readonly columns: readonly AggregateResultColumn[];
  readonly rows: readonly (readonly (AggregateGroupValue | AggregateMetricValue)[])[];
  readonly sourceRowCount: number;
  /** Total aggregate rows produced by the Gateway capability. */
  readonly resultRowCount: number;
  /** Aggregate rows actually included in these bounded details. */
  readonly returnedRowCount: number;
  /** Whether the Application output limit omitted aggregate rows. */
  readonly truncated: boolean;
}

/** Bounded filter output returned by the Application Tool and persisted in the Session. */
export interface FilterDataToolDetails {
  readonly sheetName: string;
  readonly sourceRowCount: number;
  /** Total worksheet data rows matching the filter. */
  readonly matchedRowCount: number;
  /** Ranges actually included in these bounded details. */
  readonly matchedRanges: readonly FilterRowRange[];
  /** Total ranges in the complete Gateway result. */
  readonly totalRangeCount: number;
  /** Ranges actually included in these bounded details. */
  readonly returnedRangeCount: number;
  /** Whether the Application output limit omitted ranges. */
  readonly truncated: boolean;
}
