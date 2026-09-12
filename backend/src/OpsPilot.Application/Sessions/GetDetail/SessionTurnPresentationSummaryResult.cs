namespace OpsPilot.Application.Sessions.GetDetail;

public sealed record SessionTurnPresentationSummaryResult(
    Guid TurnId,
    Guid SessionId,
    string InputEntryId,
    string Status,
    DateTimeOffset StartedAt,
    DateTimeOffset CompletedAt,
    SessionTurnPresentationUsageResult? Usage,
    IReadOnlyList<SessionToolPresentationSummaryResult> Tools);

public sealed record SessionTurnPresentationUsageResult(
    int InputTokens,
    int OutputTokens,
    int TotalTokens);

public sealed record SessionToolPresentationSummaryResult(
    string CallId,
    string Name,
    string Status,
    AgentServiceToolDisplayResult? Display,
    DateTimeOffset? StartedAt,
    DateTimeOffset? CompletedAt);

public sealed record AgentServiceToolDisplayResult(string Title, string? Subject, string? Detail);
