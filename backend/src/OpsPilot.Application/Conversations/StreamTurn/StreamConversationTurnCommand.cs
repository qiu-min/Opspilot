namespace OpsPilot.Application.Conversations.StreamTurn;

public sealed record StreamConversationTurnCommand(
    Guid ConversationId,
    Guid? FileId,
    string Message);
