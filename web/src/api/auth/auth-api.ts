import { apiRequest } from "../client";
import type { LoginRequest, LoginResponse, RegisterRequest, RegisterResponse } from "./auth-contracts";

export function login(request: LoginRequest): Promise<LoginResponse> {
  return apiRequest<LoginResponse>("/api/auth/login", {
    method: "POST",
    body: request,
  });
}

export function register(request: RegisterRequest): Promise<RegisterResponse> {
  return apiRequest<RegisterResponse>("/api/auth/register", {
    method: "POST",
    body: request,
  });
}
