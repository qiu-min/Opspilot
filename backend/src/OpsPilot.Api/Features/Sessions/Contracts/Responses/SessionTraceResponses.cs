using System.Text.Json.Serialization;

namespace OpsPilot.Api.Features.Sessions.Contracts.Responses;

public sealed record SessionTurnTraceResponse(
    Guid TurnId,
    Guid SessionId,
    string Status,
    DateTimeOffset? StartedAt,
    DateTimeOffset? EndedAt,
    long? DurationMs,
    IReadOnlyList<SessionTraceSpanResponse> Spans);

[JsonPolymorphic(TypeDiscriminatorPropertyName = "kind")]
[JsonDerivedType(typeof(SessionModelTraceSpanResponse), "model")]
[JsonDerivedType(typeof(SessionToolTraceSpanResponse), "tool")]
[JsonDerivedType(typeof(SessionCompactionTraceSpanResponse), "compaction")]
public abstract record SessionTraceSpanResponse(
    string Id,
    int Attempt,
    string Status,
    long? StartSequence,
    long? EndSequence,
    DateTimeOffset? StartedAt,
    DateTimeOffset? EndedAt,
    long? DurationMs);

public sealed record SessionModelTraceSpanResponse(
    string Id,
    int Attempt,
    string Status,
    long? StartSequence,
    long? EndSequence,
    DateTimeOffset? StartedAt,
    DateTimeOffset? EndedAt,
    long? DurationMs,
    string ModelCallId,
    SessionTraceUsageResponse? Usage,
    SessionModelTraceErrorResponse? Error,
    IReadOnlyList<SessionModelRetryTraceResponse> Retries)
    : SessionTraceSpanResponse(Id, Attempt, Status, StartSequence, EndSequence, StartedAt, EndedAt, DurationMs);

public sealed record SessionTraceUsageResponse(
    int InputTokens,
    int OutputTokens,
    int TotalTokens);

public sealed record SessionModelTraceErrorResponse(
    string Kind,
    string Code,
    string Message,
    bool Retryable,
    int? StatusCode,
    string? ProviderCode);

public sealed record SessionModelRetryTraceResponse(
    int FailedAttempt,
    int NextAttempt,
    int DelayMs,
    SessionModelTraceErrorResponse Error,
    DateTimeOffset Timestamp);

public sealed record SessionToolTraceSpanResponse(
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
    : SessionTraceSpanResponse(Id, Attempt, Status, StartSequence, EndSequence, StartedAt, EndedAt, DurationMs);

public sealed record SessionCompactionTraceSpanResponse(
    string Id,
    int Attempt,
    string Status,
    long? StartSequence,
    long? EndSequence,
    DateTimeOffset? StartedAt,
    DateTimeOffset? EndedAt,
    long? DurationMs,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? EntryId,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? SessionLeafId)
    : SessionTraceSpanResponse(Id, Attempt, Status, StartSequence, EndSequence, StartedAt, EndedAt, DurationMs);
