import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AUTH_SESSION_STORAGE_KEY,
  clearStoredAuthSession,
  isAuthSessionExpired,
  loadStoredAuthSession,
  saveAuthSession,
  type AuthSession,
} from "./auth-session";

const storage = new Map<string, string>();
const localStorageMock: Storage = {
  get length() {
    return storage.size;
  },
  clear() {
    storage.clear();
  },
  getItem(key) {
    return storage.get(key) ?? null;
  },
  key(index) {
    return [...storage.keys()][index] ?? null;
  },
  removeItem(key) {
    storage.delete(key);
  },
  setItem(key, value) {
    storage.set(key, value);
  },
};

const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

beforeEach(() => {
  storage.clear();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: localStorageMock,
  });
});

afterEach(() => {
  if (originalLocalStorageDescriptor === undefined) {
    Reflect.deleteProperty(globalThis, "localStorage");
    return;
  }

  Object.defineProperty(globalThis, "localStorage", originalLocalStorageDescriptor);
});

function createFutureSession(): AuthSession {
  return {
    userId: "user-1",
    email: "user@example.com",
    accessToken: "access-token",
    expiresAtUtc: new Date(Date.now() + 60_000).toISOString(),
  };
}

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

  it("saves and loads a valid session", () => {
    const session = createFutureSession();

    saveAuthSession(session);

    expect(loadStoredAuthSession()).toEqual(session);
  });

  it("clears an expired stored session", () => {
    storage.set(
      AUTH_SESSION_STORAGE_KEY,
      JSON.stringify({ ...createFutureSession(), expiresAtUtc: "2020-01-01T00:00:00.000Z" }),
    );

    expect(loadStoredAuthSession()).toBeNull();
    expect(storage.has(AUTH_SESSION_STORAGE_KEY)).toBe(false);
  });

  it("clears malformed JSON without throwing", () => {
    storage.set(AUTH_SESSION_STORAGE_KEY, "{broken-json");

    expect(() => loadStoredAuthSession()).not.toThrow();
    expect(loadStoredAuthSession()).toBeNull();
    expect(storage.has(AUTH_SESSION_STORAGE_KEY)).toBe(false);
  });

  it("clears a stored session with an invalid structure", () => {
    storage.set(AUTH_SESSION_STORAGE_KEY, JSON.stringify({ accessToken: 123 }));

    expect(loadStoredAuthSession()).toBeNull();
    expect(storage.has(AUTH_SESSION_STORAGE_KEY)).toBe(false);
  });

  it("clears a stored session", () => {
    saveAuthSession(createFutureSession());

    clearStoredAuthSession();

    expect(storage.has(AUTH_SESSION_STORAGE_KEY)).toBe(false);
  });
});
