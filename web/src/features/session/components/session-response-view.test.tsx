import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SessionResponseView } from "./session-response-view";
import type { TurnResponseItem } from "../types";

const response: TurnResponseItem = {
  type: "response",
  id: "response-1",
  turnId: "turn-1",
  status: "completed",
  blocks: [{ type: "assistant_text", id: "assistant-1", text: "Done", completed: true }],
};

describe("SessionResponseView developer trace entry", () => {
  it("renders Trace only when the response has a Turn identity", () => {
    const withTrace = renderToStaticMarkup(<SessionResponseView response={response} agentName="OpsPilot" onOpenTrace={vi.fn()} />);
    const withoutTrace = renderToStaticMarkup(<SessionResponseView response={{ ...response, turnId: undefined }} agentName="OpsPilot" onOpenTrace={vi.fn()} />);

    expect(withTrace).toContain("Trace");
    expect(withTrace).toContain("Open developer trace");
    expect(withoutTrace).not.toContain("Open developer trace");
  });
});
