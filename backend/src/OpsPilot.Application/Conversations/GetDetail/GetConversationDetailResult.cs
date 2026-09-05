namespace OpsPilot.Application.Conversations.GetDetail;

public sealed record GetConversationDetailResult(
    Guid Id,
    string Title,
    DateTime CreatedAtUtc,
    DateTime UpdatedAtUtc,
    IReadOnlyList<ConversationHistoryItemResult> Items);

public sealed record ConversationHistoryItemResult(
    string Type,
    string Id,
    string Role,
    string Text,
    DateTimeOffset CreatedAtUtc);
