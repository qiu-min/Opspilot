/** Base error for invalid or unavailable Excel working resource state. */
export class ExcelWorkingResourceError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ExcelWorkingResourceError';
  }
}

/** Raised when a stable source identity is reused with a different source path. */
export class ExcelWorkingResourceSourceMismatchError extends ExcelWorkingResourceError {
  public readonly sessionId: string;
  public readonly sourceResourceId: string;
  public readonly existingSourcePath: string;
  public readonly requestedSourcePath: string;

  public constructor(
    sessionId: string,
    sourceResourceId: string,
    existingSourcePath: string,
    requestedSourcePath: string,
  ) {
    super(
      `Excel working resource source mismatch for ${sessionId}/${sourceResourceId}: ` +
        `existing sourcePath does not match the requested sourcePath.`,
    );
    this.name = 'ExcelWorkingResourceSourceMismatchError';
    this.sessionId = sessionId;
    this.sourceResourceId = sourceResourceId;
    this.existingSourcePath = existingSourcePath;
    this.requestedSourcePath = requestedSourcePath;
  }
}
