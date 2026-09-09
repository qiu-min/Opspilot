export const apiErrorCodes = [
  'VALIDATION_ERROR',
  'NOT_FOUND',
  'CONFLICT',
  'TURN_STREAM_REPLAY_GAP',
  'SESSION_ACTIVE_TURN_CONFLICT',
  'SESSION_RECOVERABLE_TURN_EXISTS',
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
