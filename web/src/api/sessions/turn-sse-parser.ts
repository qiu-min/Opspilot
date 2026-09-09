import { TurnStreamProtocolError, type TurnStreamEvent } from "./turn-stream-contracts";

type SseMessage = { eventName: string; data: string; id?: string };

export async function* parseTurnSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<TurnStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "";
  let id: string | undefined;
  let dataLines: string[] = [];

  const dispatch = (): SseMessage | undefined => {
    if (!eventName && dataLines.length === 0) return undefined;
    const message = { eventName, data: dataLines.join("\n"), ...(id === undefined ? {} : { id }) };
    eventName = "";
    id = undefined;
    dataLines = [];
    return message;
  };

  const process = (line: string): SseMessage | undefined => {
    if (line === "") return dispatch();
    if (line.startsWith(":")) return undefined;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") eventName = value;
    else if (field === "id") id = value;
    else if (field === "data") dataLines.push(value);
    return undefined;
  };

  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      while (true) {
        const ending = findLineEnding(buffer);
        if (ending === undefined) break;
        const line = buffer.slice(0, ending.index);
        buffer = buffer.slice(ending.index + ending.length);
        const message = process(line);
        if (message !== undefined) yield parseTurnSseMessage(message);
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0) {
      const message = process(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
      if (message !== undefined) yield parseTurnSseMessage(message);
    }
    const trailing = dispatch();
    if (trailing !== undefined) yield parseTurnSseMessage(trailing);
  } finally {
    reader.releaseLock();
  }
}

function parseTurnSseMessage(message: SseMessage): TurnStreamEvent {
  let payload: unknown;
  try { payload = JSON.parse(message.data) as unknown; }
  catch { throw protocolError(message.eventName, "data is not valid JSON"); }
  if (!isRecord(payload)) throw protocolError(message.eventName, "data must be a JSON object");
  const type = requireNonEmptyString(payload, "type", message.eventName);
  if (type !== message.eventName) throw protocolError(message.eventName, "SSE event name must match payload.type");
  const turnId = requireNonEmptyString(payload, "turnId", type);
  const sessionId = requireNonEmptyString(payload, "sessionId", type);
  const sequence = requireSequence(payload, type);
  if (message.id !== undefined && (!/^\d+$/.test(message.id) || Number(message.id) !== sequence)) throw protocolError(type, "SSE id must equal payload.sequence");
  const timestamp = requireTimestamp(payload, type);

  switch (type) {
    case "turn_started": case "assistant_thinking_started": case "assistant_thinking_completed":
    case "assistant_message_started": case "assistant_message_completed": case "turn_cancelled":
      return { type, turnId, sessionId, sequence, timestamp } as TurnStreamEvent;
    case "assistant_text_delta":
      return { type, turnId, sessionId, sequence, timestamp, delta: requireString(payload, "delta", type) };
    case "tool_queued":
      return { type, turnId, sessionId, sequence, timestamp, callId: requireNonEmptyString(payload, "callId", type), name: requireNonEmptyString(payload, "name", type), ...(payload.batchId === undefined ? {} : { batchId: requireString(payload, "batchId", type) }) };
    case "tool_started":
      return { type, turnId, sessionId, sequence, timestamp, callId: requireNonEmptyString(payload, "callId", type), name: requireNonEmptyString(payload, "name", type) };
    case "tool_completed":
      return { type, turnId, sessionId, sequence, timestamp, callId: requireNonEmptyString(payload, "callId", type), name: requireNonEmptyString(payload, "name", type), isError: requireBoolean(payload, "isError", type) };
    case "compaction_started":
      return { type, turnId, sessionId, sequence, timestamp, ...(payload.reason === undefined ? {} : { reason: requireString(payload, "reason", type) }) };
    case "compaction_completed":
      return { type, turnId, sessionId, sequence, timestamp, ...(payload.reason === undefined ? {} : { reason: requireString(payload, "reason", type) }), ...(payload.aborted === undefined ? {} : { aborted: requireBoolean(payload, "aborted", type) }), ...(payload.failed === undefined ? {} : { failed: requireBoolean(payload, "failed", type) }), ...(payload.willRetry === undefined ? {} : { willRetry: requireBoolean(payload, "willRetry", type) }) };
    case "usage":
      return { type, turnId, sessionId, sequence, timestamp, inputTokens: requireNumber(payload, "inputTokens", type), outputTokens: requireNumber(payload, "outputTokens", type), totalTokens: requireNumber(payload, "totalTokens", type) };
    case "turn_completed":
      return { type, turnId, sessionId, sequence, timestamp, resultLeafId: requireNullableString(payload, "resultLeafId", type) };
    case "turn_failed":
      return { type, turnId, sessionId, sequence, timestamp, message: requireNonEmptyString(payload, "message", type) };
    default:
      throw protocolError(type, "unknown TurnStreamEvent type");
  }
}

function findLineEnding(text: string): { index: number; length: number } | undefined {
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") return { index, length: 1 };
    if (text[index] === "\r" && index < text.length - 1) return { index, length: text[index + 1] === "\n" ? 2 : 1 };
  }
  return undefined;
}

function requireSequence(payload: Record<string, unknown>, eventName: string): number {
  const value = payload.sequence;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw protocolError(eventName, "sequence must be a safe non-negative integer");
  return value;
}
function requireTimestamp(payload: Record<string, unknown>, eventName: string): string {
  const value = requireNonEmptyString(payload, "timestamp", eventName);
  if (Number.isNaN(Date.parse(value))) throw protocolError(eventName, "timestamp must be valid");
  return value;
}
function requireString(payload: Record<string, unknown>, field: string, eventName: string): string {
  if (typeof payload[field] !== "string") throw protocolError(eventName, `${field} must be a string`);
  return payload[field] as string;
}
function requireNonEmptyString(payload: Record<string, unknown>, field: string, eventName: string): string {
  const value = requireString(payload, field, eventName);
  if (value.trim().length === 0) throw protocolError(eventName, `${field} must not be empty`);
  return value;
}
function requireNullableString(payload: Record<string, unknown>, field: string, eventName: string): string | null {
  if (!(field in payload) || payload[field] === null) return null;
  return requireString(payload, field, eventName);
}
function requireBoolean(payload: Record<string, unknown>, field: string, eventName: string): boolean {
  if (typeof payload[field] !== "boolean") throw protocolError(eventName, `${field} must be a boolean`);
  return payload[field] as boolean;
}
function requireNumber(payload: Record<string, unknown>, field: string, eventName: string): number {
  const value = payload[field];
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) throw protocolError(eventName, `${field} must be a non-negative integer`);
  return value;
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function protocolError(eventName: string, detail: string): TurnStreamProtocolError { return new TurnStreamProtocolError(`Malformed TurnStreamEvent "${eventName}": ${detail}.`); }
