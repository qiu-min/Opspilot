import type {
  ReadRangeInput,
  ReadRangeResult,
  ReadRangeWithMetadataInput,
  ReadRangeWithMetadataResult,
  WriteDataInput,
  WriteDataResult,
} from './contracts.js';

export interface ExcelDataConnector {
  readRange(input: ReadRangeInput, signal?: AbortSignal): Promise<ReadRangeResult>;
  writeData(input: WriteDataInput, signal?: AbortSignal): Promise<WriteDataResult>;
  readRangeWithMetadata(
    input: ReadRangeWithMetadataInput,
    signal?: AbortSignal,
  ): Promise<ReadRangeWithMetadataResult>;
}
