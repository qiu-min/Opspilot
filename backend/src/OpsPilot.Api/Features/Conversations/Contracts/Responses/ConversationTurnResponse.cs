namespace OpsPilot.Api.Features.Conversations.Contracts.Responses;

public sealed record ConversationTurnResponse(
    Guid ConversationId,
    string? LeafId,
    string Status,
    string Output);
