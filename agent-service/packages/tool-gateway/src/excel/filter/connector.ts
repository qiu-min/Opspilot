import type { FilterDataInput, FilterDataResult } from './contracts.js';

export interface ExcelFilterConnector {
  /** Filters worksheet data rows using exact header names and typed conditions. */
  filterData(input: FilterDataInput, signal?: AbortSignal): Promise<FilterDataResult>;
}
