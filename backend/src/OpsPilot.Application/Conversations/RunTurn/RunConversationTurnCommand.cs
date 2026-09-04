namespace OpsPilot.Application.Conversations.RunTurn;

public sealed record RunConversationTurnCommand(
    Guid ConversationId,
    Guid? FileId,
    string Message);
