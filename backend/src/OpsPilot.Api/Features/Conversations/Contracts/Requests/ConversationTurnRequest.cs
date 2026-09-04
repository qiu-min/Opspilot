namespace OpsPilot.Api.Features.Conversations.Contracts.Requests;

public sealed record ConversationTurnRequest(
    Guid? FileId,
    string Message);
