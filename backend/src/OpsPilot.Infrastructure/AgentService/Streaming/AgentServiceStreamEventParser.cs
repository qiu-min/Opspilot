using System.Globalization;
using System.Text.Json;
using OpsPilot.Application.Abstractions.AgentService;

namespace OpsPilot.Infrastructure.AgentService.Streaming;

internal static class AgentServiceStreamEventParser
{
    private static readonly HashSet<string> EventTypes =
    [
        "turn_started", "assistant_thinking_started", "assistant_thinking_completed",
        "assistant_message_started", "assistant_text_delta", "assistant_message_completed",
        "tool_queued", "tool_started", "tool_completed", "compaction_started",
        "compaction_completed", "usage", "turn_completed", "turn_failed", "turn_cancelled",
    ];

    public static AgentTurnStreamEvent Parse(SseFrame frame)
    {
        if (!EventTypes.Contains(frame.Event)) throw Malformed(frame, "event name is not a supported TurnStreamEvent type.");
        using JsonDocument document = ParseJson(frame);
        JsonElement data = document.RootElement;
        if (data.ValueKind != JsonValueKind.Object) throw Malformed(frame, "data must be a JSON object.");
        string payloadType = RequiredString(data, "type", frame);
        if (!string.Equals(payloadType, frame.Event, StringComparison.Ordinal)) throw Malformed(frame, "SSE event name must match payload.type.");
        Guid turnId = RequiredGuid(data, "turnId", frame);
        Guid sessionId = RequiredGuid(data, "sessionId", frame);
        long sequence = RequiredSequence(data, frame);
        if (frame.Id is not null && (!long.TryParse(frame.Id, NumberStyles.Integer, CultureInfo.InvariantCulture, out long id) || id != sequence)) throw Malformed(frame, "SSE id must equal payload.sequence.");
        DateTimeOffset timestamp = RequiredTimestamp(data, frame);

        return frame.Event switch
        {
            "turn_started" => new AgentTurnStarted(turnId, sessionId, sequence, timestamp),
            "assistant_thinking_started" => new AgentAssistantThinkingStarted(turnId, sessionId, sequence, timestamp),
            "assistant_thinking_completed" => new AgentAssistantThinkingCompleted(turnId, sessionId, sequence, timestamp),
            "assistant_message_started" => new AgentAssistantMessageStarted(turnId, sessionId, sequence, timestamp),
            "assistant_text_delta" => new AgentAssistantTextDelta(turnId, sessionId, sequence, timestamp, RequiredString(data, "delta", frame)),
            "assistant_message_completed" => new AgentAssistantMessageCompleted(turnId, sessionId, sequence, timestamp),
            "tool_queued" => new AgentToolQueued(turnId, sessionId, sequence, timestamp, RequiredString(data, "callId", frame), RequiredString(data, "name", frame), OptionalString(data, "batchId", frame)),
            "tool_started" => new AgentToolStarted(turnId, sessionId, sequence, timestamp, RequiredString(data, "callId", frame), RequiredString(data, "name", frame)),
            "tool_completed" => new AgentToolCompleted(turnId, sessionId, sequence, timestamp, RequiredString(data, "callId", frame), RequiredString(data, "name", frame), RequiredBoolean(data, "isError", frame)),
            "compaction_started" => new AgentCompactionStarted(turnId, sessionId, sequence, timestamp, OptionalString(data, "reason", frame)),
            "compaction_completed" => new AgentCompactionCompleted(turnId, sessionId, sequence, timestamp, OptionalString(data, "reason", frame), OptionalBoolean(data, "aborted", frame), OptionalBoolean(data, "failed", frame), OptionalBoolean(data, "willRetry", frame)),
            "usage" => new AgentUsage(turnId, sessionId, sequence, timestamp, RequiredInt(data, "inputTokens", frame), RequiredInt(data, "outputTokens", frame), RequiredInt(data, "totalTokens", frame)),
            "turn_completed" => new AgentTurnCompleted(turnId, sessionId, sequence, timestamp, OptionalString(data, "resultLeafId", frame)),
            "turn_failed" => new AgentTurnFailed(turnId, sessionId, sequence, timestamp, RequiredString(data, "message", frame)),
            "turn_cancelled" => new AgentTurnCancelled(turnId, sessionId, sequence, timestamp),
            _ => throw Malformed(frame, "unsupported event type."),
        };
    }

    private static JsonDocument ParseJson(SseFrame frame)
    {
        try { return JsonDocument.Parse(frame.Data); }
        catch (JsonException exception) { throw Malformed(frame, "data is not valid JSON.", exception); }
    }

    private static Guid RequiredGuid(JsonElement data, string name, SseFrame frame)
    {
        string value = RequiredString(data, name, frame);
        if (!Guid.TryParse(value, out Guid result) || result == Guid.Empty) throw Malformed(frame, $"{name} must be a non-empty GUID.");
        return result;
    }

    private static long RequiredSequence(JsonElement data, SseFrame frame)
    {
        if (!data.TryGetProperty("sequence", out JsonElement value) || !value.TryGetInt64(out long sequence) || sequence < 0) throw Malformed(frame, "sequence must be a non-negative integer.");
        return sequence;
    }

    private static DateTimeOffset RequiredTimestamp(JsonElement data, SseFrame frame)
    {
        string value = RequiredString(data, "timestamp", frame);
        if (!DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out DateTimeOffset timestamp)) throw Malformed(frame, "timestamp must be a valid ISO timestamp.");
        return timestamp;
    }

    private static string RequiredString(JsonElement data, string name, SseFrame frame)
    {
        if (!data.TryGetProperty(name, out JsonElement value) || value.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(value.GetString())) throw Malformed(frame, $"{name} must be a non-empty string.");
        return value.GetString()!;
    }

    private static string? OptionalString(JsonElement data, string name, SseFrame frame)
    {
        if (!data.TryGetProperty(name, out JsonElement value) || value.ValueKind == JsonValueKind.Null) return null;
        if (value.ValueKind != JsonValueKind.String) throw Malformed(frame, $"{name} must be a string or null.");
        return value.GetString();
    }

    private static bool RequiredBoolean(JsonElement data, string name, SseFrame frame)
    {
        if (!data.TryGetProperty(name, out JsonElement value) || (value.ValueKind != JsonValueKind.True && value.ValueKind != JsonValueKind.False)) throw Malformed(frame, $"{name} must be a boolean.");
        return value.GetBoolean();
    }

    private static bool? OptionalBoolean(JsonElement data, string name, SseFrame frame)
    {
        if (!data.TryGetProperty(name, out JsonElement value) || value.ValueKind == JsonValueKind.Null) return null;
        if (value.ValueKind != JsonValueKind.True && value.ValueKind != JsonValueKind.False) throw Malformed(frame, $"{name} must be a boolean or null.");
        return value.GetBoolean();
    }

    private static int RequiredInt(JsonElement data, string name, SseFrame frame)
    {
        if (!data.TryGetProperty(name, out JsonElement value) || !value.TryGetInt32(out int result) || result < 0) throw Malformed(frame, $"{name} must be a non-negative integer.");
        return result;
    }

    private static InvalidDataException Malformed(SseFrame frame, string detail, Exception? inner = null) => new($"Malformed Agent Service TurnStreamEvent '{frame.Event}': {detail}", inner);
}
