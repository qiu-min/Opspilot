export type AuthSession = {
  readonly userId: string;
  readonly email: string;
  readonly accessToken: string;
  readonly expiresAtUtc: string;
};
