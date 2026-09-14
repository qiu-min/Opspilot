import { describe, expect, it } from "vitest";
import { formatModelRetryDelay, humanizeModelFailureKind } from "./model-reliability";

describe("model reliability presentation", () => {
  it("humanizes every provider-neutral failure kind", () => {
    expect(humanizeModelFailureKind("authentication")).toBe("Authentication");
    expect(humanizeModelFailureKind("invalid_request")).toBe("Invalid request");
    expect(humanizeModelFailureKind("rate_limit")).toBe("Rate limited");
    expect(humanizeModelFailureKind("timeout")).toBe("Request timed out");
    expect(humanizeModelFailureKind("network")).toBe("Network error");
    expect(humanizeModelFailureKind("server_error")).toBe("Provider server error");
    expect(humanizeModelFailureKind("protocol_error")).toBe("Protocol error");
    expect(humanizeModelFailureKind("context_overflow")).toBe("Context limit exceeded");
    expect(humanizeModelFailureKind("unknown")).toBe("Model request failed");
  });

  it("formats the received retry delay without creating a countdown", () => {
    expect(formatModelRetryDelay(700)).toBe("700 ms");
    expect(formatModelRetryDelay(1_000)).toBe("1 s");
    expect(formatModelRetryDelay(Number.NaN)).toBe("—");
  });
});
