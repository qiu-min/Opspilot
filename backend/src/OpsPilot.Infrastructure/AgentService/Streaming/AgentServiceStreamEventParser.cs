using System.Text.Json;
using OpsPilot.Application.Abstractions.AgentService;

namespace OpsPilot.Infrastructure.AgentService.Streaming;

internal static class AgentServiceStreamEventParser
{
    public static AgentServiceStreamEvent Parse(SseFrame frame)
    {
        if (!KnownOuterEvents.Contains(frame.Event))
        {
            return new AgentServiceStreamEvent.Unknown(frame.Event, null, frame.Data);
        }

        using JsonDocument document = ParseJson(frame);
        JsonElement data = RequireObject(document.RootElement, frame.Event);

        return frame.Event switch
        {
            "session_ready" => ParseSessionReady(data, frame),
            "agent_start" => new AgentServiceStreamEvent.AgentStarted(),
            "agent_end" => new AgentServiceStreamEvent.AgentEnded(),
            "turn_start" => new AgentServiceStreamEvent.TurnStarted(),
            "turn_end" => new AgentServiceStreamEvent.TurnEnded(),
            "message_start" => ParseMessageStarted(data, frame),
            "message_update" => ParseMessageUpdate(data, frame),
            "message_end" => ParseMessageCompleted(data, frame),
            "tool_execution_start" => ParseToolExecutionStarted(data, frame),
            "tool_execution_end" => ParseToolExecutionCompleted(data, frame),
            "compaction_start" => ParseCompactionStarted(data, frame),
            "compaction_end" => ParseCompactionCompleted(data, frame),
            "session_settled" => new AgentServiceStreamEvent.SessionSettled(),
            "done" => ParseDone(data, frame),
            "error" => ParseError(data, frame),
            _ => throw new InvalidDataException($"Unsupported known Agent Service event '{frame.Event}'."),
        };
    }

    private static readonly HashSet<string> KnownOuterEvents =
    [
        "session_ready",
        "agent_start",
        "agent_end",
        "turn_start",
        "turn_end",
        "message_start",
        "message_update",
        "message_end",
        "tool_execution_start",
        "tool_execution_end",
        "compaction_start",
        "compaction_end",
        "session_settled",
        "done",
        "error",
    ];

    private static AgentServiceStreamEvent.SessionReady ParseSessionReady(
        JsonElement data,
        SseFrame frame)
    {
        Guid sessionId = RequireGuid(data, "sessionId", frame);
        bool created = RequireBoolean(data, "created", frame);
        return new AgentServiceStreamEvent.SessionReady(sessionId, created);
    }

    private static AgentServiceStreamEvent.MessageStarted ParseMessageStarted(
        JsonElement data,
        SseFrame frame) =>
        new(RequireRole(RequireObjectProperty(data, "message", frame), "role", frame));

    private static AgentServiceStreamEvent.MessageCompleted ParseMessageCompleted(
        JsonElement data,
        SseFrame frame) =>
        new(RequireRole(RequireObjectProperty(data, "message", frame), "role", frame));

    private static AgentServiceStreamEvent ParseMessageUpdate(JsonElement data, SseFrame frame)
    {
        JsonElement nestedEvent = RequireObjectProperty(data, "event", frame);
        string nestedEventName = RequireNonEmptyString(nestedEvent, "type", frame);

        return nestedEventName switch
        {
            "text.delta" => new AgentServiceStreamEvent.TextDelta(
                RequireInt32(nestedEvent, "contentIndex", frame),
                RequireString(nestedEvent, "delta", frame)),
            "thinking.delta" => new AgentServiceStreamEvent.ThinkingDelta(
                RequireInt32(nestedEvent, "contentIndex", frame),
                RequireString(nestedEvent, "delta", frame)),
            "tool-call.delta" => new AgentServiceStreamEvent.ToolCallDelta(
                RequireInt32(nestedEvent, "contentIndex", frame),
                RequireNonEmptyString(nestedEvent, "callId", frame),
                RequireString(nestedEvent, "delta", frame)),
            "tool-call.completed" => new AgentServiceStreamEvent.ToolCallCompleted(
                RequireInt32(nestedEvent, "contentIndex", frame),
                ParseToolCall(RequireObjectProperty(nestedEvent, "toolCall", frame), frame)),
            "usage" => ParseUsage(nestedEvent, frame),
            _ => new AgentServiceStreamEvent.Unknown(frame.Event, nestedEventName, frame.Data),
        };
    }

    private static AgentServiceStreamEvent.Usage ParseUsage(
        JsonElement nestedEvent,
        SseFrame frame)
    {
        JsonElement usage = RequireObjectProperty(nestedEvent, "usage", frame);
        return new AgentServiceStreamEvent.Usage(
            RequireInt32(usage, "inputTokens", frame),
            RequireInt32(usage, "outputTokens", frame),
            RequireInt32(usage, "totalTokens", frame));
    }

    private static AgentServiceStreamEvent.ToolExecutionStarted ParseToolExecutionStarted(
        JsonElement data,
        SseFrame frame) =>
        new(ParseToolCall(RequireObjectProperty(data, "toolCall", frame), frame));

    private static AgentServiceStreamEvent.ToolExecutionCompleted ParseToolExecutionCompleted(
        JsonElement data,
        SseFrame frame) =>
        new(
            ParseToolCall(RequireObjectProperty(data, "toolCall", frame), frame),
            ParseToolResult(RequireObjectProperty(data, "result", frame), frame));

    private static AgentServiceStreamEvent.CompactionStarted ParseCompactionStarted(
        JsonElement data,
        SseFrame frame) =>
        new(RequireCompactionReason(data, frame));

    private static AgentServiceStreamEvent.CompactionCompleted ParseCompactionCompleted(
        JsonElement data,
        SseFrame frame)
    {
        string reason = RequireCompactionReason(data, frame);
        bool aborted = RequireBoolean(data, "aborted", frame);
        bool willRetry = RequireBoolean(data, "willRetry", frame);
        string? errorMessage = OptionalString(data, "errorMessage", frame);
        return new AgentServiceStreamEvent.CompactionCompleted(
            reason,
            aborted,
            willRetry,
            errorMessage);
    }

    private static AgentServiceStreamEvent.Done ParseDone(
        JsonElement data,
        SseFrame frame)
    {
        Guid sessionId = RequireGuid(data, "sessionId", frame);
        string? leafId = RequireNullableString(data, "leafId", frame);
        string status = RequireNonEmptyString(data, "status", frame);
        return new AgentServiceStreamEvent.Done(sessionId, leafId, status);
    }

    private static AgentServiceStreamEvent.Error ParseError(
        JsonElement data,
        SseFrame frame) =>
        new(RequireNonEmptyString(data, "message", frame));

    private static AgentServiceToolCall ParseToolCall(JsonElement value, SseFrame frame)
    {
        string callId = RequireNonEmptyString(value, "callId", frame);
        string name = RequireNonEmptyString(value, "name", frame);
        JsonElement arguments = RequireProperty(value, "arguments", frame);
        if (arguments.ValueKind != JsonValueKind.Object)
        {
            throw Malformed(frame, "Property 'arguments' must be a JSON object.");
        }

        return new AgentServiceToolCall(callId, name, arguments.GetRawText());
    }

    private static AgentServiceToolResult ParseToolResult(JsonElement value, SseFrame frame)
    {
        string role = RequireNonEmptyString(value, "role", frame);
        if (!string.Equals(role, "tool", StringComparison.Ordinal))
        {
            throw Malformed(frame, "Property 'result.role' must be 'tool'.");
        }

        string callId = RequireNonEmptyString(value, "callId", frame);
        string name = RequireNonEmptyString(value, "name", frame);
        JsonElement content = RequireProperty(value, "content", frame);
        if (content.ValueKind != JsonValueKind.Array || content.GetArrayLength() == 0)
        {
            throw Malformed(frame, "Property 'result.content' must be a non-empty array.");
        }

        var textContent = new List<string>(content.GetArrayLength());
        foreach (JsonElement item in content.EnumerateArray())
        {
            JsonElement contentItem = RequireObject(item, frame.Event);
            string type = RequireNonEmptyString(contentItem, "type", frame);
            if (!string.Equals(type, "text", StringComparison.Ordinal))
            {
                throw Malformed(frame, "Tool result content items must have type 'text'.");
            }

            textContent.Add(RequireString(contentItem, "text", frame));
        }

        bool isError = RequireBoolean(value, "isError", frame);
        string? detailsJson = null;
        if (value.TryGetProperty("details", out JsonElement details))
        {
            detailsJson = details.GetRawText();
        }

        return new AgentServiceToolResult(callId, name, textContent, isError, detailsJson);
    }

    private static string RequireCompactionReason(JsonElement data, SseFrame frame)
    {
        string reason = RequireNonEmptyString(data, "reason", frame);
        if (reason is not ("threshold" or "overflow"))
        {
            throw Malformed(frame, "Property 'reason' must be 'threshold' or 'overflow'.");
        }

        return reason;
    }

    private static JsonDocument ParseJson(SseFrame frame)
    {
        try
        {
            return JsonDocument.Parse(frame.Data);
        }
        catch (JsonException exception)
        {
            throw Malformed(frame, "Data is not valid JSON.", exception);
        }
    }

    private static JsonElement RequireObjectProperty(
        JsonElement parent,
        string propertyName,
        SseFrame frame) =>
        RequireObject(RequireProperty(parent, propertyName, frame), frame.Event);

    private static JsonElement RequireObject(
        JsonElement value,
        string eventName)
    {
        if (value.ValueKind != JsonValueKind.Object)
        {
            throw new InvalidDataException(
                $"Malformed Agent Service event '{eventName}': data must be a JSON object.");
        }

        return value;
    }

    private static JsonElement RequireProperty(
        JsonElement parent,
        string propertyName,
        SseFrame frame)
    {
        if (!parent.TryGetProperty(propertyName, out JsonElement value))
        {
            throw Malformed(frame, $"Missing required property '{propertyName}'.");
        }

        return value;
    }

    private static Guid RequireGuid(JsonElement parent, string propertyName, SseFrame frame)
    {
        JsonElement value = RequireProperty(parent, propertyName, frame);
        if (value.ValueKind != JsonValueKind.String ||
            !Guid.TryParse(value.GetString(), out Guid result))
        {
            throw Malformed(frame, $"Property '{propertyName}' must be a valid GUID.");
        }

        return result;
    }

    private static bool RequireBoolean(JsonElement parent, string propertyName, SseFrame frame)
    {
        JsonElement value = RequireProperty(parent, propertyName, frame);
        if (value.ValueKind != JsonValueKind.True && value.ValueKind != JsonValueKind.False)
        {
            throw Malformed(frame, $"Property '{propertyName}' must be a boolean.");
        }

        return value.GetBoolean();
    }

    private static int RequireInt32(JsonElement parent, string propertyName, SseFrame frame)
    {
        JsonElement value = RequireProperty(parent, propertyName, frame);
        if (value.ValueKind != JsonValueKind.Number || !value.TryGetInt32(out int result))
        {
            throw Malformed(frame, $"Property '{propertyName}' must be a 32-bit integer.");
        }

        return result;
    }

    private static string RequireString(JsonElement parent, string propertyName, SseFrame frame)
    {
        JsonElement value = RequireProperty(parent, propertyName, frame);
        if (value.ValueKind != JsonValueKind.String)
        {
            throw Malformed(frame, $"Property '{propertyName}' must be a string.");
        }

        return value.GetString()!;
    }

    private static string? OptionalString(
        JsonElement parent,
        string propertyName,
        SseFrame frame)
    {
        if (!parent.TryGetProperty(propertyName, out JsonElement value) ||
            value.ValueKind == JsonValueKind.Null)
        {
            return null;
        }

        if (value.ValueKind != JsonValueKind.String)
        {
            throw Malformed(frame, $"Property '{propertyName}' must be a string or null.");
        }

        return value.GetString();
    }

    private static string? RequireNullableString(
        JsonElement parent,
        string propertyName,
        SseFrame frame)
    {
        JsonElement value = RequireProperty(parent, propertyName, frame);
        if (value.ValueKind == JsonValueKind.Null) return null;
        if (value.ValueKind != JsonValueKind.String)
        {
            throw Malformed(frame, $"Property '{propertyName}' must be a string or null.");
        }

        return RequireNonEmptyStringValue(value, propertyName, frame);
    }

    private static string RequireRole(JsonElement parent, string propertyName, SseFrame frame)
    {
        string role = RequireNonEmptyString(parent, propertyName, frame);
        if (role is not ("user" or "assistant" or "tool"))
        {
            throw Malformed(frame, "Message role must be 'user', 'assistant', or 'tool'.");
        }

        return role;
    }

    private static string RequireNonEmptyString(
        JsonElement parent,
        string propertyName,
        SseFrame frame)
    {
        JsonElement value = RequireProperty(parent, propertyName, frame);
        if (value.ValueKind != JsonValueKind.String)
        {
            throw Malformed(frame, $"Property '{propertyName}' must be a string.");
        }

        return RequireNonEmptyStringValue(value, propertyName, frame);
    }

    private static string RequireNonEmptyStringValue(
        JsonElement value,
        string propertyName,
        SseFrame frame)
    {
        string result = value.GetString()!;
        if (string.IsNullOrWhiteSpace(result))
        {
            throw Malformed(frame, $"Property '{propertyName}' must not be empty.");
        }

        return result;
    }

    private static InvalidDataException Malformed(
        SseFrame frame,
        string detail,
        Exception? innerException = null) =>
        new(
            $"Malformed Agent Service event '{frame.Event}': {detail}",
            innerException);
}
