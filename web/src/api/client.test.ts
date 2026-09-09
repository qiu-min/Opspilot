import { afterEach, describe, expect, it, vi } from "vitest";
import { apiRequest, ApiError, isUnauthorizedApiError } from "./client";

describe("ApiError", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("preserves the machine-readable ProblemDetails code", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: 409,
      title: "Conflict",
      detail: "Replay gap",
      code: "TURN_STREAM_REPLAY_GAP",
    }), { status: 409, headers: { "Content-Type": "application/problem+json" } })));

    await expect(apiRequest("/api/test")).rejects.toMatchObject({
      status: 409,
      code: "TURN_STREAM_REPLAY_GAP",
    });
  });

  it("classifies only HTTP 401 ApiErrors as authentication failures", () => {
    expect(isUnauthorizedApiError(new ApiError(401, "Unauthorized", "expired"))).toBe(true);
    expect(isUnauthorizedApiError(new ApiError(400, "Bad Request", "invalid"))).toBe(false);
    expect(isUnauthorizedApiError(new Error("expired"))).toBe(false);
  });
});
