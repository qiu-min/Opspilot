using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using OpsPilot.Application.Abstractions.AgentService;
using OpsPilot.Domain.Conversations;

namespace OpsPilot.IntegrationTests;

public sealed class ConversationStreamEndpointTests : IClassFixture<ConversationTestFactory>
{
    private static readonly Guid FirstSessionId =
        Guid.Parse("11111111-1111-1111-1111-111111111111");

    private readonly ConversationTestFactory factory;
    private readonly HttpClient httpClient;

    public ConversationStreamEndpointTests(ConversationTestFactory factory)
    {
        this.factory = factory;
        httpClient = factory.CreateClient();
    }

    [Fact]
    public async Task PostStream_MapsEventsToStableSseContractAndHidesInternalData()
    {
        Conversation conversation = CreateConversation();
        factory.Conversation = conversation;
        factory.FileAsset = null;
        factory.ConversationRepository.Reset();
        factory.AgentClient.Reset();
        factory.AgentClient.StreamEvents =
        [
            new AgentServiceStreamEvent.SessionReady(FirstSessionId, true),
            new AgentServiceStreamEvent.ThinkingDelta(0, "private thinking secret"),
            new AgentServiceStreamEvent.TextDelta(0, "hello"),
            new AgentServiceStreamEvent.MessageCompleted("assistant"),
            new AgentServiceStreamEvent.ToolExecutionStarted(
                new AgentServiceToolCall("call-1", "lookup", "{\"query\":\"tool argument secret\"}")),
            new AgentServiceStreamEvent.ToolExecutionCompleted(
                new AgentServiceToolCall("call-1", "lookup", "{\"query\":\"tool argument secret\"}"),
                new AgentServiceToolResult(
                    "call-1",
                    "lookup",
                    ["tool result details secret"],
                    false,
                    "{\"details\":\"tool result details secret\"}")),
            new AgentServiceStreamEvent.Usage(10, 4, 14),
            new AgentServiceStreamEvent.CompactionStarted("overflow"),
            new AgentServiceStreamEvent.CompactionCompleted("overflow", false, false, null),
            new AgentServiceStreamEvent.Done(FirstSessionId, null, "completed"),
        ];

        using HttpResponseMessage response = await PostStreamAsync(
            conversation.Id,
            new { message = "Inspect the workbook." });
        string body = await response.Content.ReadAsStringAsync();
        IReadOnlyList<SseFrame> frames = ParseFrames(body);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("text/event-stream", response.Content.Headers.ContentType?.MediaType);
        Assert.True(response.Headers.CacheControl?.NoCache);
        Assert.True(response.Headers.CacheControl?.NoTransform);
        Assert.True(response.Headers.TryGetValues("Connection", out IEnumerable<string>? connectionValues));
        Assert.Contains("keep-alive", string.Join(',', connectionValues), StringComparison.OrdinalIgnoreCase);
        Assert.True(response.Headers.TryGetValues("X-Accel-Buffering", out IEnumerable<string>? bufferingValues));
        Assert.Equal("no", string.Join(',', bufferingValues));

        Assert.Equal(
            [
                "response_started",
                "assistant_thinking_started",
                "assistant_thinking_completed",
                "assistant_message_started",
                "assistant_text_delta",
                "assistant_message_completed",
                "tool_execution_started",
                "tool_execution_completed",
                "usage",
                "context_compaction_started",
                "context_compaction_completed",
                "response_completed",
            ],
            frames.Select(frame => frame.EventName).ToArray());

        Assert.Equal("{}", frames[0].Data);
        Assert.Equal("hello", GetData(frames[4]).GetProperty("delta").GetString());
        Assert.Equal("call-1", GetData(frames[6]).GetProperty("callId").GetString());
        Assert.Equal("lookup", GetData(frames[6]).GetProperty("name").GetString());
        Assert.False(GetData(frames[7]).GetProperty("isError").GetBoolean());
        Assert.Equal(10, GetData(frames[8]).GetProperty("inputTokens").GetInt32());
        Assert.Equal(4, GetData(frames[8]).GetProperty("outputTokens").GetInt32());
        Assert.Equal(14, GetData(frames[8]).GetProperty("totalTokens").GetInt32());
        Assert.Equal("overflow", GetData(frames[9]).GetProperty("reason").GetString());

        JsonElement completed = GetData(frames[^1]);
        Assert.Equal(conversation.Id, completed.GetProperty("conversationId").GetGuid());
        Assert.Equal(JsonValueKind.Null, completed.GetProperty("leafId").ValueKind);
        Assert.Equal("completed", completed.GetProperty("status").GetString());

        Assert.DoesNotContain("private thinking secret", body, StringComparison.Ordinal);
        Assert.DoesNotContain("tool argument secret", body, StringComparison.Ordinal);
        Assert.DoesNotContain("tool result details secret", body, StringComparison.Ordinal);
        Assert.DoesNotContain("sessionId", body, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("agentSessionId", body, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("userId", body, StringComparison.OrdinalIgnoreCase);
        Assert.Equal(1, factory.AgentClient.StreamCallCount);
        Assert.Equal(
            new AgentConversationTurnRequest(null, "Inspect the workbook.", null),
            factory.AgentClient.StreamRequest);
    }

    [Fact]
    public async Task PostStream_PreservesWhitespaceTextDeltas()
    {
        Conversation conversation = CreateConversation();
        PrepareStream(conversation,
        [
            new AgentServiceStreamEvent.SessionReady(FirstSessionId, true),
            new AgentServiceStreamEvent.TextDelta(0, " "),
            new AgentServiceStreamEvent.TextDelta(0, "\n"),
            new AgentServiceStreamEvent.MessageCompleted("assistant"),
            new AgentServiceStreamEvent.Done(FirstSessionId, null, "completed"),
        ]);

        using HttpResponseMessage response = await PostStreamAsync(
            conversation.Id,
            new { message = "Hello." });
        IReadOnlyList<SseFrame> frames = ParseFrames(
            await response.Content.ReadAsStringAsync());

        Assert.Equal(" ", GetData(frames[2]).GetProperty("delta").GetString());
        Assert.Equal("\n", GetData(frames[3]).GetProperty("delta").GetString());
    }

    [Fact]
    public async Task PostStream_WhenMessageIsBlankReturnsProblemDetailsBeforeSseStarts()
    {
        factory.Conversation = null;
        factory.FileAsset = null;
        factory.ConversationRepository.Reset();
        factory.AgentClient.Reset();

        using HttpResponseMessage response = await PostStreamAsync(
            Guid.NewGuid(),
            new { message = "  " });
        string body = await response.Content.ReadAsStringAsync();

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.NotEqual("text/event-stream", response.Content.Headers.ContentType?.MediaType);
        Assert.DoesNotContain("response_started", body, StringComparison.Ordinal);
        Assert.Equal(0, factory.AgentClient.StreamCallCount);
    }

    [Fact]
    public async Task PostStream_WhenConversationDoesNotExistReturnsProblemDetailsBeforeSseStarts()
    {
        factory.Conversation = null;
        factory.FileAsset = null;
        factory.ConversationRepository.Reset();
        factory.AgentClient.Reset();

        using HttpResponseMessage response = await PostStreamAsync(
            Guid.NewGuid(),
            new { message = "Inspect the workbook." });
        string body = await response.Content.ReadAsStringAsync();

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.NotEqual("text/event-stream", response.Content.Headers.ContentType?.MediaType);
        Assert.DoesNotContain("response_started", body, StringComparison.Ordinal);
        Assert.Equal(0, factory.AgentClient.StreamCallCount);
    }

    [Fact]
    public async Task PostStream_WhenProtocolFailsBeforeResponseStartedReturnsProblemDetails()
    {
        Conversation conversation = CreateConversation();
        PrepareStream(conversation, [new AgentServiceStreamEvent.AgentStarted()]);

        using HttpResponseMessage response = await PostStreamAsync(
            conversation.Id,
            new { message = "Hello." });
        string body = await response.Content.ReadAsStringAsync();

        Assert.Equal(HttpStatusCode.InternalServerError, response.StatusCode);
        Assert.NotEqual("text/event-stream", response.Content.Headers.ContentType?.MediaType);
        Assert.DoesNotContain("response_started", body, StringComparison.Ordinal);
        Assert.DoesNotContain(
            "Agent Service stream must begin with a session-ready event.",
            body,
            StringComparison.Ordinal);
    }

    [Fact]
    public async Task PostStream_WhenApplicationYieldsErrorWritesOnlyPublicErrorTerminal()
    {
        Conversation conversation = CreateConversation();
        PrepareStream(
            conversation,
            [
                new AgentServiceStreamEvent.SessionReady(FirstSessionId, true),
                new AgentServiceStreamEvent.Error("Internal server error."),
            ]);

        using HttpResponseMessage response = await PostStreamAsync(
            conversation.Id,
            new { message = "Hello." });
        IReadOnlyList<SseFrame> frames = ParseFrames(
            await response.Content.ReadAsStringAsync());

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(["response_started", "error"], frames.Select(frame => frame.EventName));
        Assert.Equal("Internal server error.", GetData(frames[1]).GetProperty("message").GetString());
        Assert.DoesNotContain(frames, frame => frame.EventName == "response_completed");
    }

    [Fact]
    public async Task PostStream_WhenApplicationEndsWithoutTerminalWritesGenericSseError()
    {
        Conversation conversation = CreateConversation();
        PrepareStream(
            conversation,
            [
                new AgentServiceStreamEvent.SessionReady(FirstSessionId, true),
                new AgentServiceStreamEvent.MessageStarted("assistant"),
                new AgentServiceStreamEvent.TextDelta(0, "partial"),
                new AgentServiceStreamEvent.MessageCompleted("assistant"),
            ]);

        using HttpResponseMessage response = await PostStreamAsync(
            conversation.Id,
            new { message = "Hello." });
        string body = await response.Content.ReadAsStringAsync();
        IReadOnlyList<SseFrame> frames = ParseFrames(body);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("error", frames[^1].EventName);
        Assert.Equal(
            "Internal server error.",
            GetData(frames[^1]).GetProperty("message").GetString());
        Assert.DoesNotContain(
            "Agent Service stream ended without a terminal event.",
            body,
            StringComparison.Ordinal);
    }

    [Fact]
    public async Task PostStream_StopsAfterResponseCompletedEvenIfFakeHasMoreEvents()
    {
        Conversation conversation = CreateConversation();
        PrepareStream(
            conversation,
            [
                new AgentServiceStreamEvent.SessionReady(FirstSessionId, true),
                new AgentServiceStreamEvent.Done(FirstSessionId, null, "completed"),
                new AgentServiceStreamEvent.TextDelta(0, "must not be written"),
            ]);

        using HttpResponseMessage response = await PostStreamAsync(
            conversation.Id,
            new { message = "Hello." });
        string body = await response.Content.ReadAsStringAsync();
        IReadOnlyList<SseFrame> frames = ParseFrames(body);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(
            ["response_started", "response_completed"],
            frames.Select(frame => frame.EventName));
        Assert.DoesNotContain("must not be written", body, StringComparison.Ordinal);
    }

    private async Task<HttpResponseMessage> PostStreamAsync(Guid conversationId, object requestBody)
    {
        return await httpClient.PostAsJsonAsync(
            $"/api/conversations/{conversationId}/turns/stream",
            requestBody);
    }

    private void PrepareStream(
        Conversation conversation,
        IReadOnlyList<AgentServiceStreamEvent> events)
    {
        factory.Conversation = conversation;
        factory.FileAsset = null;
        factory.ConversationRepository.Reset();
        factory.AgentClient.Reset();
        factory.AgentClient.StreamEvents = events;
    }

    private Conversation CreateConversation() =>
        Conversation.Create(
            factory.CurrentUserId,
            Conversation.DefaultTitle,
            new DateTime(2026, 8, 25, 12, 0, 0, DateTimeKind.Utc));

    private static IReadOnlyList<SseFrame> ParseFrames(string body)
    {
        return body
            .Split("\n\n", StringSplitOptions.RemoveEmptyEntries)
            .Select(frame =>
            {
                string[] lines = frame.Split('\n');
                string eventName = lines
                    .Single(line => line.TrimEnd('\r').StartsWith("event: ", StringComparison.Ordinal))
                    .TrimEnd('\r')[7..];
                string data = lines
                    .Single(line => line.TrimEnd('\r').StartsWith("data: ", StringComparison.Ordinal))
                    .TrimEnd('\r')[6..];
                return new SseFrame(eventName, data);
            })
            .ToArray();
    }

    private static JsonElement GetData(SseFrame frame)
    {
        using JsonDocument document = JsonDocument.Parse(frame.Data);
        return document.RootElement.Clone();
    }

    private sealed record SseFrame(string EventName, string Data);
}
