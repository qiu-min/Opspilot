namespace OpsPilot.Api.Features.Conversations.Contracts.Responses;

public sealed record ConversationDetailResponse(
    Guid Id,
    string Title,
    DateTime CreatedAtUtc,
    DateTime UpdatedAtUtc,
    IReadOnlyList<ConversationHistoryItemResponse> Items);

public sealed record ConversationHistoryItemResponse(
    string Type,
    string Id,
    string Role,
    string Text,
    DateTimeOffset CreatedAtUtc);
