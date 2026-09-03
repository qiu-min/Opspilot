import { apiRequest } from "../client";
import type { LoginRequest, LoginResponse } from "./auth-contracts";

export function login(request: LoginRequest): Promise<LoginResponse> {
  return apiRequest<LoginResponse>("/api/auth/login", {
    method: "POST",
    body: request,
  });
}
