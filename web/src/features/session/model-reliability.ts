import type { ModelFailureKind } from "../../api/sessions/turn-stream-contracts";

const MODEL_FAILURE_KIND_LABELS: Record<ModelFailureKind, string> = {
  authentication: "Authentication",
  invalid_request: "Invalid request",
  rate_limit: "Rate limited",
  timeout: "Request timed out",
  network: "Network error",
  server_error: "Provider server error",
  protocol_error: "Protocol error",
  context_overflow: "Context limit exceeded",
  unknown: "Model request failed",
};

/** Presentation-only labels for provider-neutral model failure kinds. */
export function humanizeModelFailureKind(kind: ModelFailureKind): string {
  return MODEL_FAILURE_KIND_LABELS[kind];
}

export function formatModelRetryDelay(delayMs: number): string {
  if (!Number.isFinite(delayMs) || delayMs < 0) return "—";
  if (delayMs < 1_000) return `${Math.round(delayMs)} ms`;
  return `${parseFloat((delayMs / 1_000).toFixed(1))} s`;
}
