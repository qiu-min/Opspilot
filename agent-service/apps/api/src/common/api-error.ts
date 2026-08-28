export const apiErrorCodes = [
  'VALIDATION_ERROR',
  'NOT_FOUND',
  'CONFLICT',
  'INTERNAL_ERROR',
] as const;

export type ApiErrorCode = (typeof apiErrorCodes)[number];

export interface ApiErrorResponse {
  readonly statusCode: number;
  readonly code: ApiErrorCode;
  readonly message: string;
  readonly requestId: string;
  readonly timestamp: string;
  readonly details?: Record<string, readonly string[]>;
}
