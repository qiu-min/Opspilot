namespace OpsPilot.Application.Sessions.RunTurn;
public sealed record RunSessionTurnCommand(Guid SessionId, Guid? FileId, string Message);
