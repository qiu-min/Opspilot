import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConversationResponseView } from "./conversation-response-view";
import type { ConversationResponseItem } from "../types";

function occurrences(markup: string, value: string): number {
  return markup.split(value).length - 1;
}

describe("ConversationResponseView", () => {
  it("renders one response header/actions around ordered assistant and execution blocks", () => {
    const response: ConversationResponseItem = {
      type: "response",
      id: "response-1",
      status: "completed",
      blocks: [
        { type: "assistant_text", id: "assistant-1", text: "First", completed: true },
        {
          type: "agent_execution",
          id: "execution-a",
          batchId: "batch-a",
          steps: [
            { id: "call-a", callId: "call-a", name: "read_workbook", status: "completed" },
            { id: "call-b", callId: "call-b", name: "inspect_worksheets", status: "failed" },
          ],
        },
        { type: "assistant_text", id: "assistant-2", text: "Second", completed: true },
        {
          type: "agent_execution",
          id: "execution-b",
          batchId: "batch-b",
          steps: [
            { id: "call-c", callId: "call-c", name: "write_workbook", status: "completed" },
          ],
        },
        { type: "assistant_text", id: "assistant-3", text: "Final", completed: true },
      ],
    };

    const markup = renderToStaticMarkup(
      <ConversationResponseView response={response} agentName="OpsPilot" />,
    );

    expect(occurrences(markup, "AI generated")).toBe(1);
    expect(occurrences(markup, 'aria-label="Agent execution')).toBe(2);
    expect(occurrences(markup, "Copy response")).toBe(1);
    expect(occurrences(markup, "Helpful response")).toBe(1);
    expect(occurrences(markup, "Unhelpful response")).toBe(1);
    expect(markup.indexOf("First")).toBeLessThan(markup.indexOf("Read workbook"));
    expect(markup.indexOf("Read workbook")).toBeLessThan(markup.indexOf("Second"));
    expect(markup.indexOf("Second")).toBeLessThan(markup.indexOf("Write workbook"));
    expect(markup.indexOf("Write workbook")).toBeLessThan(markup.indexOf("Final"));
    expect(markup).toContain("Failed");
  });
});
