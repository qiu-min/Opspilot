using System.Text.Json.Serialization;

namespace OpsPilot.Api.Features.Sessions.Contracts.Responses;

public sealed record CreateSessionResponse(Guid Id, string Title, DateTime CreatedAtUtc, DateTime UpdatedAtUtc);
public sealed record SessionSummaryResponse(Guid Id, string Title, DateTime UpdatedAtUtc);
public sealed record SessionDetailResponse(
    Guid Id,
    string Title,
    DateTime CreatedAtUtc,
    DateTime UpdatedAtUtc,
    IReadOnlyList<SessionHistoryItemResponse> Items,
    IReadOnlyList<SessionTurnPresentationSummaryResponse> TurnSummaries);
public sealed record SessionTurnResponse(Guid SessionId, Guid TurnId, string? LeafId, string Status, string Output);

public sealed record SessionTurnPresentationSummaryResponse(
    Guid TurnId,
    Guid SessionId,
    string InputEntryId,
    string Status,
    DateTimeOffset StartedAt,
    DateTimeOffset CompletedAt,
    SessionTurnPresentationUsageResponse? Usage,
    IReadOnlyList<SessionToolPresentationSummaryResponse> Tools);

public sealed record SessionTurnPresentationUsageResponse(int InputTokens, int OutputTokens, int TotalTokens);

public sealed record SessionToolPresentationSummaryResponse(
    string CallId,
    string Name,
    string Status,
    SessionToolDisplayInfoResponse? Display,
    DateTimeOffset? StartedAt,
    DateTimeOffset? CompletedAt);

public sealed record SessionToolDisplayInfoResponse(string Title, string? Subject, string? Detail);

[JsonPolymorphic(TypeDiscriminatorPropertyName = "type")]
[JsonDerivedType(typeof(SessionHistoryMessageItemResponse), "message")]
[JsonDerivedType(typeof(SessionHistoryToolExecutionItemResponse), "tool_execution")]
public abstract record SessionHistoryItemResponse(string Id, DateTimeOffset CreatedAtUtc);
public sealed record SessionHistoryMessageItemResponse(string Id, string Role, string Text, DateTimeOffset CreatedAtUtc) : SessionHistoryItemResponse(Id, CreatedAtUtc);
public sealed record SessionHistoryToolExecutionItemResponse(string Id, string CallId, string Name, string Status, DateTimeOffset CreatedAtUtc) : SessionHistoryItemResponse(Id, CreatedAtUtc);
