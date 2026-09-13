import type { ModelErrorInfo } from '@opspilot/model-gateway';
import type { ModelFailureSnapshot } from '@opspilot/domain';

const LEGACY_MODEL_FAILURE_MESSAGE = 'Model call failed.';

/** Maps the Model Gateway contract to the Domain-owned durable failure snapshot. */
export function toModelFailureSnapshot(
  modelError: ModelErrorInfo | undefined,
  fallbackMessage?: string,
): ModelFailureSnapshot {
  if (modelError !== undefined) {
    return {
      kind: modelError.kind,
      code: modelError.code,
      message: modelError.message,
      retryable: modelError.retryable,
      ...(modelError.statusCode === undefined ? {} : { statusCode: modelError.statusCode }),
      ...(modelError.providerCode === undefined ? {} : { providerCode: modelError.providerCode }),
    };
  }

  const message = fallbackMessage?.trim() || LEGACY_MODEL_FAILURE_MESSAGE;
  return {
    kind: 'unknown',
    code: 'MODEL_UNKNOWN',
    message,
    retryable: false,
  };
}
