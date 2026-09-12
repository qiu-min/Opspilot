import { describe, expect, it } from "vitest";
import { aggregateTurnUsage, formatDuration, formatTokenCount, formatTurnMetrics, getDurationMs } from "./turn-metrics";

describe("turn metrics", () => {
  it("sums usage from every model call and returns null when absent", () => {
    expect(aggregateTurnUsage([])).toBeNull();
    expect(aggregateTurnUsage([{ inputTokens: 10, outputTokens: 20, totalTokens: 30 }, { inputTokens: 4, outputTokens: 6, totalTokens: 10 }])).toEqual({ inputTokens: 14, outputTokens: 26, totalTokens: 40 });
  });

  it("formats durations and token counts for compact UI labels", () => {
    expect(formatDuration(420)).toBe("420ms");
    expect(formatDuration(1_240)).toBe("1.2s");
    expect(formatDuration(12_000)).toBe("12s");
    expect(formatDuration(61_000)).toBe("1m 1s");
    expect(formatTokenCount(850)).toBe("850 tokens");
    expect(formatTokenCount(0)).toBe("0 tokens");
    expect(formatTokenCount(1_400)).toBe("1.4k tokens");
    expect(formatTokenCount(12_800)).toBe("12.8k tokens");
    expect(getDurationMs("2026-09-09T00:00:00Z", "2026-09-09T00:00:01Z")).toBe(1_000);
    expect(getDurationMs("invalid", "2026-09-09T00:00:01Z")).toBeUndefined();
  });

  it("formats response metrics and omits tokens when usage is absent", () => {
    expect(formatTurnMetrics({ startedAt: "2026-09-09T00:00:00Z", completedAt: "2026-09-09T00:00:01Z", usage: null, toolCount: 0 }, "completed", Date.parse("2026-09-09T00:00:01Z"))).toBe("1s");
    expect(formatTurnMetrics({ startedAt: "2026-09-09T00:00:00Z", usage: { inputTokens: 800, outputTokens: 1_000, totalTokens: 1_800 }, toolCount: 2 }, "streaming", Date.parse("2026-09-09T00:00:04.800Z"))).toBe("Running · 4.8s · 1.8k tokens · 2 tools");
  });
});
