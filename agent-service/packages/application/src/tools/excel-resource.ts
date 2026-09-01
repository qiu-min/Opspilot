/** Identifies the workbook available to an Application Tool execution. */
export interface ExcelResource {
  readonly id: string;
  readonly filePath: string;
}
