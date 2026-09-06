namespace OpsPilot.Application.Conversations.GetDetail;

public sealed record GetConversationDetailResult(
    Guid Id,
    string Title,
    DateTime CreatedAtUtc,
    DateTime UpdatedAtUtc,
    IReadOnlyList<ConversationHistoryItemResult> Items);
