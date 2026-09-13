/** Provider-neutral categories persisted for a failed model call. */
export type ModelFailureKind =
  | 'authentication'
  | 'invalid_request'
  | 'rate_limit'
  | 'timeout'
  | 'network'
  | 'server_error'
  | 'protocol_error'
  | 'context_overflow'
  | 'unknown';

/** Safe durable snapshot of a model failure; Provider exceptions are not persisted. */
export interface ModelFailureSnapshot {
  readonly kind: ModelFailureKind;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly statusCode?: number;
  readonly providerCode?: string;
}
