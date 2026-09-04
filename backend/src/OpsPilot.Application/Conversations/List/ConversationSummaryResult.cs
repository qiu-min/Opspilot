namespace OpsPilot.Application.Conversations.List;

public sealed record ConversationSummaryResult(
    Guid Id,
    string Title,
    DateTime UpdatedAtUtc);
