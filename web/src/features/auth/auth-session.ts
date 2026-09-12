export type AuthSession = {
  readonly userId: string;
  readonly email: string;
  readonly accessToken: string;
  readonly expiresAtUtc: string;
};

export const AUTH_SESSION_STORAGE_KEY = "opspilot.auth.session";

export function isAuthSessionExpired(
  session: Pick<AuthSession, "expiresAtUtc">,
  now = Date.now(),
): boolean {
  const expiresAt = Date.parse(session.expiresAtUtc);
  return !Number.isFinite(expiresAt) || expiresAt <= now;
}

function isAuthSession(value: unknown): value is AuthSession {
  if (typeof value !== "object" || value === null) return false;

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.userId === "string" &&
    typeof candidate.email === "string" &&
    typeof candidate.accessToken === "string" &&
    typeof candidate.expiresAtUtc === "string"
  );
}

export function loadStoredAuthSession(): AuthSession | null {
  const storedSession = localStorage.getItem(AUTH_SESSION_STORAGE_KEY);
  if (storedSession === null) return null;

  let parsedSession: unknown;
  try {
    parsedSession = JSON.parse(storedSession);
  } catch {
    clearStoredAuthSession();
    return null;
  }

  if (!isAuthSession(parsedSession) || isAuthSessionExpired(parsedSession)) {
    clearStoredAuthSession();
    return null;
  }

  return parsedSession;
}

export function saveAuthSession(session: AuthSession): void {
  localStorage.setItem(AUTH_SESSION_STORAGE_KEY, JSON.stringify(session));
}

export function clearStoredAuthSession(): void {
  localStorage.removeItem(AUTH_SESSION_STORAGE_KEY);
}
