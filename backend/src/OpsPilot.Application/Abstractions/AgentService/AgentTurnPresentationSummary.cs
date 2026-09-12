namespace OpsPilot.Application.Abstractions.AgentService;

public sealed record AgentTurnPresentationSummary(
    Guid TurnId,
    Guid SessionId,
    string InputEntryId,
    string Status,
    DateTimeOffset StartedAt,
    DateTimeOffset CompletedAt,
    AgentTurnPresentationUsage? Usage,
    IReadOnlyList<AgentTurnToolPresentationSummary> Tools);

public sealed record AgentTurnPresentationUsage(
    int InputTokens,
    int OutputTokens,
    int TotalTokens);

public sealed record AgentTurnToolPresentationSummary(
    string CallId,
    string Name,
    string Status,
    AgentToolDisplayInfo? Display,
    DateTimeOffset? StartedAt,
    DateTimeOffset? CompletedAt);
