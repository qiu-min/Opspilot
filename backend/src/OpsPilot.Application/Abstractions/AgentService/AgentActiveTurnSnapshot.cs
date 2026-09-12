namespace OpsPilot.Application.Abstractions.AgentService;

public sealed record AgentActiveTurnSnapshot(
    Guid TurnId,
    Guid SessionId,
    string Status,
    AgentTurnStreamProjection Projection);

public sealed record AgentTurnStreamProjection(
    Guid TurnId,
    Guid SessionId,
    string Status,
    AgentTurnAssistantProjection Assistant,
    IReadOnlyList<AgentTurnToolProjection> Tools,
    AgentTurnCompactionProjection Compaction,
    AgentTurnUsage? Usage,
    long LastSequence);

public sealed record AgentTurnAssistantProjection(string Text, bool MessageVisible, bool IsThinking);
public sealed record AgentTurnToolProjection(string CallId, string Name, string Status, AgentToolDisplayInfo? Display = null);
public sealed record AgentTurnCompactionProjection(string Status);
public sealed record AgentTurnUsage(int InputTokens, int OutputTokens, int TotalTokens);
