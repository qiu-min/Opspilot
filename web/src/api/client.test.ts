import { afterEach, describe, expect, it, vi } from "vitest";
import { apiRequest } from "./client";

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
});
