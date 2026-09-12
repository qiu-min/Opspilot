import { describe, expect, it } from "vitest";
import { parseTurnSseStream } from "./turn-sse-parser";
import { TurnStreamProtocolError, type TurnStreamEvent } from "./turn-stream-contracts";

async function parse(input: string): Promise<TurnStreamEvent[]> {
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(input)); controller.close(); } });
  const events: TurnStreamEvent[] = [];
  for await (const event of parseTurnSseStream(stream)) events.push(event);
  return events;
}

const base = { turnId: "11111111-1111-4111-8111-111111111111", sessionId: "22222222-2222-4222-8222-222222222222", timestamp: "2026-09-09T00:00:00.000Z" };

describe("Turn SSE parser", () => {
  it("validates event name, identity and sequence id", async () => {
    const [event] = await parse(`id: 0\nevent: turn_started\ndata: ${JSON.stringify({ ...base, type: "turn_started", sequence: 0 })}\n\n`);
    expect(event.type).toBe("turn_started");
    await expect(parse(`id: 1\nevent: turn_started\ndata: ${JSON.stringify({ ...base, type: "turn_started", sequence: 0 })}\n\n`)).rejects.toBeInstanceOf(TurnStreamProtocolError);
  });

  it("rejects unknown protocol events instead of silently reducing them", async () => {
    await expect(parse(`event: response_started\ndata: {}\n\n`)).rejects.toBeInstanceOf(TurnStreamProtocolError);
  });

  it("parses optional tool display metadata and remains compatible when omitted", async () => {
    const [withDisplay] = await parse(`event: tool_started\ndata: ${JSON.stringify({ ...base, type: "tool_started", sequence: 0, callId: "call-1", name: "get_sheet_profile", display: { title: "Inspect Worksheet", subject: "Sheet1" } })}\n\n`);
    expect(withDisplay).toMatchObject({ type: "tool_started", display: { title: "Inspect Worksheet", subject: "Sheet1" } });

    const [withoutDisplay] = await parse(`event: tool_started\ndata: ${JSON.stringify({ ...base, type: "tool_started", sequence: 0, callId: "call-1", name: "get_sheet_profile" })}\n\n`);
    expect(withoutDisplay).not.toHaveProperty("display");
  });

  it.each([
    ["invalid display object", "invalid", "display must be an object"],
    ["missing title", {}, "title must be a string"],
    ["invalid subject", { title: "Inspect Worksheet", subject: 123 }, "subject must be a string"],
    ["invalid detail", { title: "Inspect Worksheet", detail: 123 }, "detail must be a string"],
  ])("rejects %s", async (_label, display, expectedMessage) => {
    const payload = { ...base, type: "tool_started", sequence: 0, callId: "call-1", name: "get_sheet_profile", display };
    await expect(parse(`event: tool_started\ndata: ${JSON.stringify(payload)}\n\n`)).rejects.toThrow(expectedMessage);
  });
});
