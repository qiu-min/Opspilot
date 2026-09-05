import {
  ConversationStreamProtocolError,
  type ConversationStreamEvent,
} from "./conversation-stream-contracts";

type SseMessage = {
  eventName: string;
  data: string;
};

export async function* parseConversationSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<ConversationStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let textBuffer = "";
  let eventName = "";
  let dataLines: string[] = [];

  const dispatchMessage = (): SseMessage | undefined => {
    if (!eventName && dataLines.length === 0) {
      return undefined;
    }

    const message: SseMessage = {
      eventName,
      data: dataLines.join("\n"),
    };
    eventName = "";
    dataLines = [];
    return message;
  };

  const processLine = (line: string): SseMessage | undefined => {
    if (line === "") {
      return dispatchMessage();
    }

    if (line.startsWith(":")) {
      return undefined;
    }

    const separatorIndex = line.indexOf(":");
    const field = separatorIndex === -1 ? line : line.slice(0, separatorIndex);
    let value = separatorIndex === -1 ? "" : line.slice(separatorIndex + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }

    if (field === "event") {
      eventName = value;
    } else if (field === "data") {
      dataLines.push(value);
    }

    return undefined;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      textBuffer += decoder.decode(value, { stream: true });

      while (true) {
        const lineEnding = findLineEnding(textBuffer);
        if (lineEnding === undefined) {
          break;
        }

        const line = textBuffer.slice(0, lineEnding.index);
        textBuffer = textBuffer.slice(lineEnding.index + lineEnding.length);
        const message = processLine(line);
        if (message !== undefined) {
          const parsedEvent = parseConversationSseMessage(message);
          if (parsedEvent !== undefined) {
            yield parsedEvent;
          }
        }
      }
    }

    textBuffer += decoder.decode();
    if (textBuffer.length > 0) {
      const line = textBuffer.endsWith("\r")
        ? textBuffer.slice(0, -1)
        : textBuffer;
      const message = processLine(line);
      if (message !== undefined) {
        const parsedEvent = parseConversationSseMessage(message);
        if (parsedEvent !== undefined) {
          yield parsedEvent;
        }
      }
    }

    const trailingMessage = dispatchMessage();
    if (trailingMessage !== undefined) {
      const parsedEvent = parseConversationSseMessage(trailingMessage);
      if (parsedEvent !== undefined) {
        yield parsedEvent;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function findLineEnding(
  text: string,
): { index: number; length: number } | undefined {
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\n") {
      return { index, length: 1 };
    }

    if (character === "\r") {
      if (index === text.length - 1) {
        return undefined;
      }

      return {
        index,
        length: text[index + 1] === "\n" ? 2 : 1,
      };
    }
  }

  return undefined;
}

function parseConversationSseMessage(
  message: SseMessage,
): ConversationStreamEvent | undefined {
  switch (message.eventName) {
    case "response_started":
      return parseEmptyEvent(message, "response_started");
    case "assistant_thinking_started":
      return parseEmptyEvent(message, "assistant_thinking_started");
    case "assistant_thinking_completed":
      return parseEmptyEvent(message, "assistant_thinking_completed");
    case "assistant_message_started":
      return parseEmptyEvent(message, "assistant_message_started");
    case "assistant_text_delta": {
      const payload = parsePayload(message);
      return {
        type: "assistant_text_delta",
        delta: requireString(payload, "delta", message.eventName),
      };
    }
    case "assistant_message_completed":
      return parseEmptyEvent(message, "assistant_message_completed");
    case "tool_execution_started": {
      const payload = parsePayload(message);
      return {
        type: "tool_execution_started",
        callId: requireString(payload, "callId", message.eventName),
        name: requireString(payload, "name", message.eventName),
      };
    }
    case "tool_execution_completed": {
      const payload = parsePayload(message);
      return {
        type: "tool_execution_completed",
        callId: requireString(payload, "callId", message.eventName),
        name: requireString(payload, "name", message.eventName),
        isError: requireBoolean(payload, "isError", message.eventName),
      };
    }
    case "usage": {
      const payload = parsePayload(message);
      return {
        type: "usage",
        inputTokens: requireNumber(payload, "inputTokens", message.eventName),
        outputTokens: requireNumber(payload, "outputTokens", message.eventName),
        totalTokens: requireNumber(payload, "totalTokens", message.eventName),
      };
    }
    case "context_compaction_started": {
      const payload = parsePayload(message);
      return {
        type: "context_compaction_started",
        reason: requireString(payload, "reason", message.eventName),
      };
    }
    case "context_compaction_completed": {
      const payload = parsePayload(message);
      return {
        type: "context_compaction_completed",
        reason: requireString(payload, "reason", message.eventName),
        aborted: requireBoolean(payload, "aborted", message.eventName),
        failed: requireBoolean(payload, "failed", message.eventName),
        willRetry: requireBoolean(payload, "willRetry", message.eventName),
      };
    }
    case "response_completed": {
      const payload = parsePayload(message);
      const leafId = requireNullableString(payload, "leafId", message.eventName);
      return {
        type: "response_completed",
        conversationId: requireString(payload, "conversationId", message.eventName),
        leafId,
        status: requireString(payload, "status", message.eventName),
      };
    }
    case "error": {
      const payload = parsePayload(message);
      return {
        type: "error",
        message: requireString(payload, "message", message.eventName),
      };
    }
    default:
      return undefined;
  }
}

type EmptyConversationStreamEventType =
  | "response_started"
  | "assistant_thinking_started"
  | "assistant_thinking_completed"
  | "assistant_message_started"
  | "assistant_message_completed";

function parseEmptyEvent<TEventType extends EmptyConversationStreamEventType>(
  message: SseMessage,
  eventName: TEventType,
): Extract<ConversationStreamEvent, { type: TEventType }> {
  assertPayloadRecord(message);
  return { type: eventName } as Extract<ConversationStreamEvent, { type: TEventType }>;
}

function parsePayload(message: SseMessage): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message.data) as unknown;
  } catch {
    throw protocolError(message.eventName, "data is not valid JSON");
  }

  if (!isRecord(parsed)) {
    throw protocolError(message.eventName, "data must be a JSON object");
  }

  return parsed;
}

function assertPayloadRecord(message: SseMessage): void {
  parsePayload(message);
}

function requireString(
  payload: Record<string, unknown>,
  field: string,
  eventName: string,
): string {
  const value = payload[field];
  if (typeof value !== "string") {
    throw protocolError(eventName, `${field} must be a string`);
  }

  return value;
}

function requireNullableString(
  payload: Record<string, unknown>,
  field: string,
  eventName: string,
): string | null {
  const value = payload[field];
  if (value !== null && typeof value !== "string") {
    throw protocolError(eventName, `${field} must be a string or null`);
  }

  return value as string | null;
}

function requireBoolean(
  payload: Record<string, unknown>,
  field: string,
  eventName: string,
): boolean {
  const value = payload[field];
  if (typeof value !== "boolean") {
    throw protocolError(eventName, `${field} must be a boolean`);
  }

  return value;
}

function requireNumber(
  payload: Record<string, unknown>,
  field: string,
  eventName: string,
): number {
  const value = payload[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw protocolError(eventName, `${field} must be a number`);
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function protocolError(eventName: string, detail: string): ConversationStreamProtocolError {
  return new ConversationStreamProtocolError(
    `Malformed conversation stream event "${eventName}": ${detail}.`,
  );
}
