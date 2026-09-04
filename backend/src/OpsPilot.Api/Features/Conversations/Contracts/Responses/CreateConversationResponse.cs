namespace OpsPilot.Api.Features.Conversations.Contracts.Responses;

public sealed record CreateConversationResponse(
    Guid Id,
    string Title,
    DateTime CreatedAtUtc,
    DateTime UpdatedAtUtc);
