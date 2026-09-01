namespace OpsPilot.Application.Conversations.RunTurn;

public sealed record RunConversationTurnResult(
    Guid SessionId,
    string? LeafId,
    string Status,
    string Output);
