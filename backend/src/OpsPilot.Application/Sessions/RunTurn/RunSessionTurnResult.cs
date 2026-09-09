namespace OpsPilot.Application.Sessions.RunTurn;
public sealed record RunSessionTurnResult(Guid SessionId, Guid TurnId, string? LeafId, string Status, string Output);
