namespace OpsPilot.Application.Abstractions.AgentService;

/// <summary>Transparent PR2 live UI event contract. It is not a durable TurnEvent.</summary>
public abstract record AgentTurnStreamEvent(Guid TurnId, Guid SessionId, long Sequence, DateTimeOffset Timestamp)
{
    public abstract string Type { get; }
}

public sealed record AgentTurnStarted(Guid TurnId, Guid SessionId, long Sequence, DateTimeOffset Timestamp)
    : AgentTurnStreamEvent(TurnId, SessionId, Sequence, Timestamp) { public override string Type => "turn_started"; }
public sealed record AgentAssistantThinkingStarted(Guid TurnId, Guid SessionId, long Sequence, DateTimeOffset Timestamp)
    : AgentTurnStreamEvent(TurnId, SessionId, Sequence, Timestamp) { public override string Type => "assistant_thinking_started"; }
public sealed record AgentAssistantThinkingCompleted(Guid TurnId, Guid SessionId, long Sequence, DateTimeOffset Timestamp)
    : AgentTurnStreamEvent(TurnId, SessionId, Sequence, Timestamp) { public override string Type => "assistant_thinking_completed"; }
public sealed record AgentAssistantMessageStarted(Guid TurnId, Guid SessionId, long Sequence, DateTimeOffset Timestamp)
    : AgentTurnStreamEvent(TurnId, SessionId, Sequence, Timestamp) { public override string Type => "assistant_message_started"; }
public sealed record AgentAssistantTextDelta(Guid TurnId, Guid SessionId, long Sequence, DateTimeOffset Timestamp, string Delta)
    : AgentTurnStreamEvent(TurnId, SessionId, Sequence, Timestamp) { public override string Type => "assistant_text_delta"; }
public sealed record AgentAssistantMessageCompleted(Guid TurnId, Guid SessionId, long Sequence, DateTimeOffset Timestamp)
    : AgentTurnStreamEvent(TurnId, SessionId, Sequence, Timestamp) { public override string Type => "assistant_message_completed"; }
public sealed record AgentToolQueued(Guid TurnId, Guid SessionId, long Sequence, DateTimeOffset Timestamp, string CallId, string Name, string? BatchId, AgentToolDisplayInfo? Display = null)
    : AgentTurnStreamEvent(TurnId, SessionId, Sequence, Timestamp) { public override string Type => "tool_queued"; }
public sealed record AgentToolStarted(Guid TurnId, Guid SessionId, long Sequence, DateTimeOffset Timestamp, string CallId, string Name, AgentToolDisplayInfo? Display = null)
    : AgentTurnStreamEvent(TurnId, SessionId, Sequence, Timestamp) { public override string Type => "tool_started"; }
public sealed record AgentToolCompleted(Guid TurnId, Guid SessionId, long Sequence, DateTimeOffset Timestamp, string CallId, string Name, bool IsError, AgentToolDisplayInfo? Display = null)
    : AgentTurnStreamEvent(TurnId, SessionId, Sequence, Timestamp) { public override string Type => "tool_completed"; }
public sealed record AgentCompactionStarted(Guid TurnId, Guid SessionId, long Sequence, DateTimeOffset Timestamp, string? Reason)
    : AgentTurnStreamEvent(TurnId, SessionId, Sequence, Timestamp) { public override string Type => "compaction_started"; }
public sealed record AgentCompactionCompleted(Guid TurnId, Guid SessionId, long Sequence, DateTimeOffset Timestamp, string? Reason, bool? Aborted, bool? Failed, bool? WillRetry)
    : AgentTurnStreamEvent(TurnId, SessionId, Sequence, Timestamp) { public override string Type => "compaction_completed"; }
public sealed record AgentUsage(Guid TurnId, Guid SessionId, long Sequence, DateTimeOffset Timestamp, int InputTokens, int OutputTokens, int TotalTokens)
    : AgentTurnStreamEvent(TurnId, SessionId, Sequence, Timestamp) { public override string Type => "usage"; }
public sealed record AgentTurnCompleted(Guid TurnId, Guid SessionId, long Sequence, DateTimeOffset Timestamp, string? ResultLeafId)
    : AgentTurnStreamEvent(TurnId, SessionId, Sequence, Timestamp) { public override string Type => "turn_completed"; }
public sealed record AgentTurnFailed(Guid TurnId, Guid SessionId, long Sequence, DateTimeOffset Timestamp, string Message)
    : AgentTurnStreamEvent(TurnId, SessionId, Sequence, Timestamp) { public override string Type => "turn_failed"; }
public sealed record AgentTurnCancelled(Guid TurnId, Guid SessionId, long Sequence, DateTimeOffset Timestamp)
    : AgentTurnStreamEvent(TurnId, SessionId, Sequence, Timestamp) { public override string Type => "turn_cancelled"; }
