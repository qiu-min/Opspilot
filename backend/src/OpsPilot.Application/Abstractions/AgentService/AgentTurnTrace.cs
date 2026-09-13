using System.Text.Json.Serialization;

namespace OpsPilot.Application.Abstractions.AgentService;

public sealed record AgentTurnTrace(
    Guid TurnId,
    Guid SessionId,
    string Status,
    DateTimeOffset? StartedAt,
    DateTimeOffset? EndedAt,
    long? DurationMs,
    IReadOnlyList<AgentTraceSpan> Spans);

[JsonPolymorphic(TypeDiscriminatorPropertyName = "kind")]
[JsonDerivedType(typeof(AgentModelTraceSpan), "model")]
[JsonDerivedType(typeof(AgentToolTraceSpan), "tool")]
[JsonDerivedType(typeof(AgentCompactionTraceSpan), "compaction")]
public abstract record AgentTraceSpan(
    string Id,
    int Attempt,
    string Status,
    long? StartSequence,
    long? EndSequence,
    DateTimeOffset? StartedAt,
    DateTimeOffset? EndedAt,
    long? DurationMs);

public sealed record AgentModelTraceSpan(
    string Id,
    int Attempt,
    string Status,
    long? StartSequence,
    long? EndSequence,
    DateTimeOffset? StartedAt,
    DateTimeOffset? EndedAt,
    long? DurationMs,
    string ModelCallId,
    AgentModelTraceUsage? Usage,
    AgentModelTraceError? Error = null)
    : AgentTraceSpan(Id, Attempt, Status, StartSequence, EndSequence, StartedAt, EndedAt, DurationMs)
{
    public IReadOnlyList<AgentModelRetryTrace> Retries { get; init; } =
        Array.Empty<AgentModelRetryTrace>();
}

public sealed record AgentModelTraceError(
    string Kind,
    string Code,
    string Message,
    bool Retryable,
    int? StatusCode = null,
    string? ProviderCode = null);

public sealed record AgentModelRetryTrace(
    int FailedAttempt,
    int NextAttempt,
    int DelayMs,
    AgentModelTraceError Error,
    DateTimeOffset Timestamp);

public sealed record AgentModelTraceUsage(
    int InputTokens,
    int OutputTokens,
    int TotalTokens);

public sealed record AgentToolTraceSpan(
    string Id,
    int Attempt,
    string Status,
    long? StartSequence,
    long? EndSequence,
    DateTimeOffset? StartedAt,
    DateTimeOffset? EndedAt,
    long? DurationMs,
    string CallId,
    string Name,
    DateTimeOffset? RequestedAt,
    bool IsError)
    : AgentTraceSpan(Id, Attempt, Status, StartSequence, EndSequence, StartedAt, EndedAt, DurationMs);

public sealed record AgentCompactionTraceSpan(
    string Id,
    int Attempt,
    string Status,
    long? StartSequence,
    long? EndSequence,
    DateTimeOffset? StartedAt,
    DateTimeOffset? EndedAt,
    long? DurationMs,
    string? EntryId,
    string? SessionLeafId)
    : AgentTraceSpan(Id, Attempt, Status, StartSequence, EndSequence, StartedAt, EndedAt, DurationMs);
