namespace OpsPilot.Api.Features.Conversations.Contracts.Responses;

public sealed record ConversationTurnResponse(
    Guid SessionId,
    string? LeafId,
    string Status,
    string Output);
