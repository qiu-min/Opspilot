namespace OpsPilot.Api.Features.Conversations.Contracts.Responses;

public sealed record ConversationSummaryResponse(
    Guid Id,
    string Title,
    DateTime UpdatedAtUtc);
