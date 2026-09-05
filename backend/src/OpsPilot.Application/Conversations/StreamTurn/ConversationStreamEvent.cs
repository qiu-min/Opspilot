namespace OpsPilot.Application.Conversations.StreamTurn;

public abstract record ConversationStreamEvent
{
    public sealed record ResponseStarted : ConversationStreamEvent;

    public sealed record AssistantThinkingStarted : ConversationStreamEvent;

    public sealed record AssistantThinkingCompleted : ConversationStreamEvent;

    public sealed record AssistantMessageStarted : ConversationStreamEvent;

    public sealed record AssistantTextDelta(
        string Delta)
        : ConversationStreamEvent;

    public sealed record AssistantMessageCompleted : ConversationStreamEvent;

    public sealed record ToolExecutionStarted(
        string CallId,
        string Name)
        : ConversationStreamEvent;

    public sealed record ToolExecutionCompleted(
        string CallId,
        string Name,
        bool IsError)
        : ConversationStreamEvent;

    public sealed record Usage(
        int InputTokens,
        int OutputTokens,
        int TotalTokens)
        : ConversationStreamEvent;

    public sealed record ContextCompactionStarted(
        string Reason)
        : ConversationStreamEvent;

    public sealed record ContextCompactionCompleted(
        string Reason,
        bool Aborted,
        bool Failed,
        bool WillRetry)
        : ConversationStreamEvent;

    public sealed record ResponseCompleted(
        Guid ConversationId,
        string? LeafId,
        string Status)
        : ConversationStreamEvent;

    public sealed record Error(
        string Message)
        : ConversationStreamEvent;
}
