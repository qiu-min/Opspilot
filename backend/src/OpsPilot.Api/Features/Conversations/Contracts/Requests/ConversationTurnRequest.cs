namespace OpsPilot.Api.Features.Conversations.Contracts.Requests;

public sealed record ConversationTurnRequest(
    Guid? SessionId,
    Guid? FileId,
    string Message);
