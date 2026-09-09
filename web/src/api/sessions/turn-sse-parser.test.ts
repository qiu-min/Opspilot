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
});
