namespace OpsPilot.Application.Conversations.RunTurn;

public sealed record RunConversationTurnCommand(
    Guid? SessionId,
    Guid? FileId,
    string Message);
