namespace OpsPilot.Application.Sessions.Trace;

public sealed record GetSessionTurnTraceQuery(Guid SessionId, Guid TurnId);
