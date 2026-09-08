/** Mutable product metadata owned by the Session aggregate. */
export interface SessionMetadata {
  readonly id: string;
  readonly title: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Returns a canonical non-empty title or raises a domain validation error. */
export function normalizeSessionTitle(title: string): string {
  const normalized = title.trim();
  if (normalized.length === 0) {
    throw new Error('Session title must not be empty or whitespace-only.');
  }
  return normalized;
}
