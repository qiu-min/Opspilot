import type { AggregateDataInput, AggregateDataResult } from './contracts.js';

export interface ExcelAggregateConnector {
  /** Aggregates worksheet rows by selected columns and metrics. */
  aggregateData(input: AggregateDataInput, signal?: AbortSignal): Promise<AggregateDataResult>;
}
