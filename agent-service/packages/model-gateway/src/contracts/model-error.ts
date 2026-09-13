import { z } from 'zod';

/** Provider-neutral categories used to describe a model call failure. */
export type ModelErrorKind =
  | 'authentication'
  | 'invalid_request'
  | 'rate_limit'
  | 'timeout'
  | 'network'
  | 'server_error'
  | 'protocol_error'
  | 'context_overflow'
  | 'unknown';

/** Stable OpsPilot codes for the corresponding model error categories. */
export type ModelErrorCode =
  | 'MODEL_AUTHENTICATION'
  | 'MODEL_INVALID_REQUEST'
  | 'MODEL_RATE_LIMIT'
  | 'MODEL_TIMEOUT'
  | 'MODEL_NETWORK'
  | 'MODEL_SERVER_ERROR'
  | 'MODEL_PROTOCOL_ERROR'
  | 'MODEL_CONTEXT_OVERFLOW'
  | 'MODEL_UNKNOWN';

/** Canonical code and retryability metadata for each structured model error kind. */
export const MODEL_ERROR_METADATA = {
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
  ModelErrorKind,
  { readonly code: ModelErrorCode; readonly retryable: boolean }
>;

/** Structured, safe diagnostics for a failed model call. */
export interface ModelErrorInfo {
  readonly kind: ModelErrorKind;
  readonly code: ModelErrorCode;
  readonly message: string;
  /** Whether a later RetryPolicy may consider this category transient. */
  readonly retryable: boolean;
  readonly statusCode?: number;
  readonly providerCode?: string;
}

export const modelErrorKindSchema = z.enum([
  'authentication',
  'invalid_request',
  'rate_limit',
  'timeout',
  'network',
  'server_error',
  'protocol_error',
  'context_overflow',
  'unknown',
]);

export const modelErrorCodeSchema = z.enum([
  'MODEL_AUTHENTICATION',
  'MODEL_INVALID_REQUEST',
  'MODEL_RATE_LIMIT',
  'MODEL_TIMEOUT',
  'MODEL_NETWORK',
  'MODEL_SERVER_ERROR',
  'MODEL_PROTOCOL_ERROR',
  'MODEL_CONTEXT_OVERFLOW',
  'MODEL_UNKNOWN',
]);

/** Runtime schema for the public structured model failure contract. */
export const modelErrorInfoSchema = z
  .object({
    kind: modelErrorKindSchema,
    code: modelErrorCodeSchema,
    message: z.string().trim().min(1).max(100_000),
    retryable: z.boolean(),
    statusCode: z.number().int().min(100).max(599).optional(),
    providerCode: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9_.:-]+$/)
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const expected = MODEL_ERROR_METADATA[value.kind];
    if (value.code !== expected.code) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['code'],
        message: `code must be ${expected.code} for ${value.kind}.`,
      });
    }
    if (value.retryable !== expected.retryable) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['retryable'],
        message: `retryable must be ${String(expected.retryable)} for ${value.kind}.`,
      });
    }
  });
