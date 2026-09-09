namespace OpsPilot.Application.Sessions.StreamTurn;
public sealed record StreamSessionTurnCommand(Guid SessionId, Guid? FileId, string Message);
