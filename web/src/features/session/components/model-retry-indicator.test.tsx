import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ModelRetryIndicator } from "./model-retry-indicator";
import { hydrateTurnStreamStateFromProjection } from "../turn-stream-state";

const projection = {
  turnId: "turn-1",
  sessionId: "session-1",
  status: "running" as const,
  assistant: { text: "", messageVisible: false, isThinking: false },
  tools: [],
  compaction: { status: "idle" as const },
  usage: null,
  retry: { modelCallId: "model-1", failedAttempt: 1, nextAttempt: 2, delayMs: 500, kind: "rate_limit" as const },
  lastSequence: 3,
};

describe("ModelRetryIndicator", () => {
  it("renders the hydrated active-turn retry state without diagnostics", () => {
    const state = hydrateTurnStreamStateFromProjection(projection);
    const markup = renderToStaticMarkup(<ModelRetryIndicator retry={state.retry} />);

    expect(markup).toContain("Retrying model request");
    expect(markup).toContain("Attempt 2");
    expect(markup).toContain("Rate limited");
    expect(markup).toContain("500 ms");
    expect(markup).not.toContain("model-1");
    expect(markup).not.toContain('role="status"');
    expect(markup).not.toContain("aria-live");
  });

  it("renders nothing after the retry state is cleared", () => {
    expect(renderToStaticMarkup(<ModelRetryIndicator retry={null} />)).toBe("");
  });
});
