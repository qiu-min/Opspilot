namespace OpsPilot.Application.Abstractions.AgentService;

public sealed record AgentConversationHistoryItem(
    string Type,
    string Id,
    string Role,
    string Text,
    DateTimeOffset CreatedAt);
