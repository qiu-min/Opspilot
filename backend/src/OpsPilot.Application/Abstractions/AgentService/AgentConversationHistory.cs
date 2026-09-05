namespace OpsPilot.Application.Abstractions.AgentService;

public sealed record AgentConversationHistory(
    string? LeafId,
    IReadOnlyList<AgentConversationHistoryItem> Items);
