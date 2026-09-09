using System.Text.Json.Serialization;

namespace OpsPilot.Api.Features.Sessions.Contracts.Responses;

public sealed record CreateSessionResponse(Guid Id, string Title, DateTime CreatedAtUtc, DateTime UpdatedAtUtc);
public sealed record SessionSummaryResponse(Guid Id, string Title, DateTime UpdatedAtUtc);
public sealed record SessionDetailResponse(Guid Id, string Title, DateTime CreatedAtUtc, DateTime UpdatedAtUtc, IReadOnlyList<SessionHistoryItemResponse> Items);
public sealed record SessionTurnResponse(Guid SessionId, Guid TurnId, string? LeafId, string Status, string Output);

[JsonPolymorphic(TypeDiscriminatorPropertyName = "type")]
[JsonDerivedType(typeof(SessionHistoryMessageItemResponse), "message")]
[JsonDerivedType(typeof(SessionHistoryToolExecutionItemResponse), "tool_execution")]
public abstract record SessionHistoryItemResponse(string Id, DateTimeOffset CreatedAtUtc);
public sealed record SessionHistoryMessageItemResponse(string Id, string Role, string Text, DateTimeOffset CreatedAtUtc) : SessionHistoryItemResponse(Id, CreatedAtUtc);
public sealed record SessionHistoryToolExecutionItemResponse(string Id, string CallId, string Name, string Status, DateTimeOffset CreatedAtUtc) : SessionHistoryItemResponse(Id, CreatedAtUtc);
