namespace OpsPilot.Application.Conversations.RunTurn;

public sealed record RunConversationTurnResult(
    Guid ConversationId,
    string? LeafId,
    string Status,
    string Output);
