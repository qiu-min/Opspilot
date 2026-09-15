import type {
  AggregateGroupValue,
  AggregateMetricValue,
  AggregateResultColumn,
  FilterRowRange,
} from '@opspilot/tool-gateway';

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
