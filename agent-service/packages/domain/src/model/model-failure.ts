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

/** Durable OpsPilot codes owned by the domain model-failure contract. */
export type ModelFailureCode =
  | 'MODEL_AUTHENTICATION'
  | 'MODEL_INVALID_REQUEST'
  | 'MODEL_RATE_LIMIT'
  | 'MODEL_TIMEOUT'
  | 'MODEL_NETWORK'
  | 'MODEL_SERVER_ERROR'
  | 'MODEL_PROTOCOL_ERROR'
  | 'MODEL_CONTEXT_OVERFLOW'
  | 'MODEL_UNKNOWN';

/** Canonical durable code and retryability metadata for model failure kinds. */
export const MODEL_FAILURE_METADATA = {
  authentication: { code: 'MODEL_AUTHENTICATION', retryable: false },
  invalid_request: { code: 'MODEL_INVALID_REQUEST', retryable: false },
  rate_limit: { code: 'MODEL_RATE_LIMIT', retryable: true },
  timeout: { code: 'MODEL_TIMEOUT', retryable: true },
  network: { code: 'MODEL_NETWORK', retryable: true },
  server_error: { code: 'MODEL_SERVER_ERROR', retryable: true },
  protocol_error: { code: 'MODEL_PROTOCOL_ERROR', retryable: false },
  context_overflow: { code: 'MODEL_CONTEXT_OVERFLOW', retryable: false },
  unknown: { code: 'MODEL_UNKNOWN', retryable: false },
} as const satisfies Record<
  ModelFailureKind,
  { readonly code: ModelFailureCode; readonly retryable: boolean }
>;

/** Safe durable snapshot of a model failure; Provider exceptions are not persisted. */
export interface ModelFailureSnapshot {
  readonly kind: ModelFailureKind;
  readonly code: ModelFailureCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly statusCode?: number;
  readonly providerCode?: string;
}
