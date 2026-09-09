import { describe, expect, it } from "vitest";
import { isAuthSessionExpired } from "./auth-session";

describe("auth session lifetime", () => {
  it("expires at or after the server-provided expiry", () => {
    const session = { expiresAtUtc: "2026-09-10T00:00:00.000Z" };
    const expiry = Date.parse(session.expiresAtUtc);

    expect(isAuthSessionExpired(session, expiry - 1)).toBe(false);
    expect(isAuthSessionExpired(session, expiry)).toBe(true);
  });

  it("treats an invalid expiry as unusable", () => {
    expect(isAuthSessionExpired({ expiresAtUtc: "not-a-date" })).toBe(true);
  });
});
