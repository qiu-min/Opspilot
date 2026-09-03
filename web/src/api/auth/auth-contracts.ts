export type LoginRequest = {
  email: string;
  password: string;
};

export type LoginResponse = {
  userId: string;
  email: string;
  accessToken: string;
  expiresAtUtc: string;
};
