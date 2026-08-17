import { z } from 'zod';

export const modelGatewayErrorCodeSchema = z.enum([
  'CONFIGURATION',
  'INVALID_INPUT',
  'INVALID_RESPONSE',
  'INVALID_TOOL_CALL',
  'UNSUPPORTED_CAPABILITY',
  'AUTHENTICATION',
  'RATE_LIMITED',
  'TIMEOUT',
  'MODEL_REFUSAL',
  'PROVIDER_FAILURE',
]);
export type ModelGatewayErrorCode = z.infer<typeof modelGatewayErrorCodeSchema>;

export class ModelGatewayError extends Error {
  readonly name = 'ModelGatewayError';

  constructor(
    readonly code: ModelGatewayErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
  }
}

export function isModelGatewayError(
  error: unknown,
  code?: ModelGatewayErrorCode,
): error is ModelGatewayError {
  return error instanceof ModelGatewayError && (code === undefined || error.code === code);
}

export function toModelGatewayError(error: unknown): ModelGatewayError {
  return error instanceof ModelGatewayError
    ? error
    : new ModelGatewayError('PROVIDER_FAILURE', 'Model provider failed.');
}
