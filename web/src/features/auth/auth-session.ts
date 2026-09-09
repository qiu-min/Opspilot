export type AuthSession = {
  readonly userId: string;
  readonly email: string;
  readonly accessToken: string;
  readonly expiresAtUtc: string;
};

export function isAuthSessionExpired(
  session: Pick<AuthSession, "expiresAtUtc">,
  now = Date.now(),
): boolean {
  const expiresAt = Date.parse(session.expiresAtUtc);
  return !Number.isFinite(expiresAt) || expiresAt <= now;
}
