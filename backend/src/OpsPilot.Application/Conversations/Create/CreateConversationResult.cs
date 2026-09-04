namespace OpsPilot.Application.Conversations.Create;

public sealed record CreateConversationResult(
    Guid Id,
    string Title,
    DateTime CreatedAtUtc,
    DateTime UpdatedAtUtc);
