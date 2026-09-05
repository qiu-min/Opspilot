namespace OpsPilot.Application.Abstractions.AgentService;

public abstract record AgentServiceStreamEvent
{
    public sealed record SessionReady(
        Guid SessionId,
        bool Created)
        : AgentServiceStreamEvent;

    public sealed record AgentStarted : AgentServiceStreamEvent;

    public sealed record AgentEnded : AgentServiceStreamEvent;

    public sealed record TurnStarted : AgentServiceStreamEvent;

    public sealed record TurnEnded : AgentServiceStreamEvent;

    public sealed record MessageStarted(
        string Role)
        : AgentServiceStreamEvent;

    public sealed record TextDelta(
        int ContentIndex,
        string Delta)
        : AgentServiceStreamEvent;

    public sealed record ThinkingDelta(
        int ContentIndex,
        string Delta)
        : AgentServiceStreamEvent;

    public sealed record ToolCallDelta(
        int ContentIndex,
        string CallId,
        string Delta)
        : AgentServiceStreamEvent;

    public sealed record ToolCallCompleted(
        int ContentIndex,
        AgentServiceToolCall ToolCall)
        : AgentServiceStreamEvent;

    public sealed record Usage(
        int InputTokens,
        int OutputTokens,
        int TotalTokens)
        : AgentServiceStreamEvent;

    public sealed record MessageCompleted(
        string Role)
        : AgentServiceStreamEvent;

    public sealed record ToolExecutionStarted(
        AgentServiceToolCall ToolCall)
        : AgentServiceStreamEvent;

    public sealed record ToolExecutionCompleted(
        AgentServiceToolCall ToolCall,
        AgentServiceToolResult Result)
        : AgentServiceStreamEvent;

    public sealed record CompactionStarted(
        string Reason)
        : AgentServiceStreamEvent;

    public sealed record CompactionCompleted(
        string Reason,
        bool Aborted,
        bool WillRetry,
        string? ErrorMessage)
        : AgentServiceStreamEvent;

    public sealed record SessionSettled : AgentServiceStreamEvent;

    public sealed record Done(
        Guid SessionId,
        string? LeafId,
        string Status)
        : AgentServiceStreamEvent;

    public sealed record Error(
        string Message)
        : AgentServiceStreamEvent;

    public sealed record Unknown(
        string EventName,
        string? NestedEventName,
        string Data)
        : AgentServiceStreamEvent;
}
