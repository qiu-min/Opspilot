using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using OpsPilot.Application.Conversations.StreamTurn;

namespace OpsPilot.Api.Features.Conversations.Streaming;

public static class ConversationSseSerializer
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
    };

    public static async Task WriteAsync(
        HttpResponse response,
        ConversationStreamEvent streamEvent,
        CancellationToken cancellationToken)
    {
        string frame = Serialize(streamEvent);
        byte[] bytes = Encoding.UTF8.GetBytes(frame);

        await response.Body.WriteAsync(bytes, cancellationToken);
        await response.Body.FlushAsync(cancellationToken);
    }

    private static string Serialize(ConversationStreamEvent streamEvent)
    {
        ConversationSseFrame frame = streamEvent switch
        {
            ConversationStreamEvent.ResponseStarted =>
                new("response_started", new EmptyPayload()),
            ConversationStreamEvent.AssistantThinkingStarted =>
                new("assistant_thinking_started", new EmptyPayload()),
            ConversationStreamEvent.AssistantThinkingCompleted =>
                new("assistant_thinking_completed", new EmptyPayload()),
            ConversationStreamEvent.AssistantMessageStarted =>
                new("assistant_message_started", new EmptyPayload()),
            ConversationStreamEvent.AssistantTextDelta textDelta =>
                new("assistant_text_delta", new AssistantTextDeltaPayload(textDelta.Delta)),
            ConversationStreamEvent.AssistantMessageCompleted =>
                new("assistant_message_completed", new EmptyPayload()),
            ConversationStreamEvent.ToolExecutionStarted toolStarted =>
                new(
                    "tool_execution_started",
                    new ToolExecutionStartedPayload(toolStarted.CallId, toolStarted.Name)),
            ConversationStreamEvent.ToolExecutionCompleted toolCompleted =>
                new(
                    "tool_execution_completed",
                    new ToolExecutionCompletedPayload(
                        toolCompleted.CallId,
                        toolCompleted.Name,
                        toolCompleted.IsError)),
            ConversationStreamEvent.Usage usage =>
                new(
                    "usage",
                    new UsagePayload(
                        usage.InputTokens,
                        usage.OutputTokens,
                        usage.TotalTokens)),
            ConversationStreamEvent.ContextCompactionStarted compactionStarted =>
                new(
                    "context_compaction_started",
                    new ContextCompactionStartedPayload(compactionStarted.Reason)),
            ConversationStreamEvent.ContextCompactionCompleted compactionCompleted =>
                new(
                    "context_compaction_completed",
                    new ContextCompactionCompletedPayload(
                        compactionCompleted.Reason,
                        compactionCompleted.Aborted,
                        compactionCompleted.Failed,
                        compactionCompleted.WillRetry)),
            ConversationStreamEvent.ResponseCompleted responseCompleted =>
                new(
                    "response_completed",
                    new ResponseCompletedPayload(
                        responseCompleted.ConversationId,
                        responseCompleted.LeafId,
                        responseCompleted.Status)),
            ConversationStreamEvent.Error error =>
                new("error", new ErrorPayload(error.Message)),
            _ => throw new ArgumentOutOfRangeException(nameof(streamEvent), streamEvent, null),
        };

        return $"event: {frame.EventName}\ndata: {JsonSerializer.Serialize(frame.Data, JsonOptions)}\n\n";
    }

    private sealed record ConversationSseFrame(
        string EventName,
        object Data);

    private sealed record EmptyPayload;

    private sealed record AssistantTextDeltaPayload(string Delta);

    private sealed record ToolExecutionStartedPayload(string CallId, string Name);

    private sealed record ToolExecutionCompletedPayload(
        string CallId,
        string Name,
        bool IsError);

    private sealed record UsagePayload(
        int InputTokens,
        int OutputTokens,
        int TotalTokens);

    private sealed record ContextCompactionStartedPayload(string Reason);

    private sealed record ContextCompactionCompletedPayload(
        string Reason,
        bool Aborted,
        bool Failed,
        bool WillRetry);

    private sealed record ResponseCompletedPayload(
        Guid ConversationId,
        string? LeafId,
        string Status);

    private sealed record ErrorPayload(string Message);
}
