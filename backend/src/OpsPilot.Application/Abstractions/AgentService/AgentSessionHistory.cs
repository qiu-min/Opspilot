namespace OpsPilot.Application.Abstractions.AgentService;

public sealed record AgentSessionHistory(
    string? LeafId,
    IReadOnlyList<AgentSessionHistoryItem> Items,
    IReadOnlyList<AgentTurnPresentationSummary>? TurnSummaries = null);
