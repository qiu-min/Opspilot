export function serializeTurnExecutionEvent(event: unknown): string {
  return JSON.stringify(sanitizeTurnValue(event));
}

function sanitizeTurnValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizeTurnValue(item));
  if (!isRecord(value)) return value;

  const sanitized: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (value.role === 'assistant' && key === 'errorMessage') continue;
    sanitized[key] = sanitizeTurnValue(nestedValue);
  }
  return sanitized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
