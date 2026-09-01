namespace OpsPilot.Application.Abstractions.AgentService;

public sealed record AgentConversationTurnResult(
    Guid SessionId,
    string? LeafId,
    string Status,
    string Output);
