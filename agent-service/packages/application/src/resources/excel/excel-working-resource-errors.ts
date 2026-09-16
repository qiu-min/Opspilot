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

/** Raised when a Session does not expose the requested Excel resource. */
export class ExcelResourceNotFoundError extends ExcelWorkingResourceError {
  public readonly sessionId: string;
  public readonly resourceId: string;

  public constructor(sessionId: string, resourceId: string) {
    super(`Excel resource was not found for Session ${sessionId}: ${resourceId}.`);
    this.name = 'ExcelResourceNotFoundError';
    this.sessionId = sessionId;
    this.resourceId = resourceId;
  }
}

/** Raised when the committed workbook can no longer be read. */
export class ExcelResourceContentNotFoundError extends ExcelWorkingResourceError {
  public readonly sessionId: string;
  public readonly resourceId: string;

  public constructor(sessionId: string, resourceId: string, options?: ErrorOptions) {
    super(`Excel resource content was not found for Session ${sessionId}: ${resourceId}.`, options);
    this.name = 'ExcelResourceContentNotFoundError';
    this.sessionId = sessionId;
    this.resourceId = resourceId;
  }
}
