namespace OpsPilot.Application.Abstractions.AgentService;

public sealed record AgentTurnResult(Guid SessionId, Guid TurnId, string? LeafId, string Status, string Output);
