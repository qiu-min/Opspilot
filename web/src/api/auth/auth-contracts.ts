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

export type RegisterRequest = {
  email: string;
  password: string;
};

export type RegisterResponse = {
  id: string;
  email: string;
  createdAtUtc: string;
};
