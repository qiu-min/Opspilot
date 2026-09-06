import { describe, expect, it } from "vitest";
import {
  ConversationStreamProtocolError,
  type ConversationStreamEvent,
} from "./conversation-stream-contracts";
import { parseConversationSseStream } from "./conversation-sse-parser";

async function parseSse(input: string): Promise<ConversationStreamEvent[]> {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(input));
      controller.close();
    },
  });

  const events: ConversationStreamEvent[] = [];
  for await (const event of parseConversationSseStream(stream)) {
    events.push(event);
  }
  return events;
}

describe("conversation SSE parser", () => {
  it("parses a queued tool execution without exposing tool arguments", async () => {
    await expect(parseSse([
      "event: tool_execution_queued",
      'data: {"batchId":"tool-batch-call-1","callId":"call-1","name":"read_workbook"}',
      "",
    ].join("\n"))).resolves.toEqual([
      {
        type: "tool_execution_queued",
        batchId: "tool-batch-call-1",
        callId: "call-1",
        name: "read_workbook",
      },
    ]);
  });

  it.each(["batchId", "callId", "name"])(
    "rejects an empty queued tool %s",
    async (field) => {
      const payload = {
        batchId: "batch-1",
        callId: "call-1",
        name: "read_workbook",
        [field]: "  ",
      };

      await expect(parseSse([
        "event: tool_execution_queued",
        `data: ${JSON.stringify(payload)}`,
        "",
      ].join("\n"))).rejects.toBeInstanceOf(ConversationStreamProtocolError);
    },
  );
});
