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

/** Structured, safe diagnostics for a failed model call. */
export interface ModelErrorInfo {
  readonly kind: ModelErrorKind;
  readonly code: string;
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
  .strict();
