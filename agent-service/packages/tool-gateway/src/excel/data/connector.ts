import type {
  ReadRangeInput,
  ReadRangeResult,
  ReadRangeWithMetadataInput,
  ReadRangeWithMetadataResult,
  WriteDataInput,
  WriteDataResult,
} from './contracts.js';

export interface ExcelDataConnector {
  /** Reads a value-oriented range from an Excel worksheet. */
  readRange(input: ReadRangeInput, signal?: AbortSignal): Promise<ReadRangeResult>;
  /** Writes a rectangular data set to an Excel worksheet. */
  writeData(input: WriteDataInput, signal?: AbortSignal): Promise<WriteDataResult>;
  /** Reads worksheet cells with optional validation metadata. */
  readRangeWithMetadata(
    input: ReadRangeWithMetadataInput,
    signal?: AbortSignal,
  ): Promise<ReadRangeWithMetadataResult>;
}
