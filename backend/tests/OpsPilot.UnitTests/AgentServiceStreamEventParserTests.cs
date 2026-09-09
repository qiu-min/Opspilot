using System.Net;
using System.Text;
using System.Text.Json;
using OpsPilot.Application.Abstractions.AgentService;
using OpsPilot.Infrastructure.AgentService;

namespace OpsPilot.UnitTests;

public sealed class AgentServiceStreamEventParserTests
{
    private static readonly Guid SessionId = Guid.Parse("55555555-5555-4555-8555-555555555555");
    private static readonly Guid TurnId = Guid.Parse("66666666-6666-4666-8666-666666666666");

    [Theory]
    [InlineData("")]
    [InlineData(" ")]
    [InlineData("\n")]
    [InlineData("\n\n")]
    [InlineData("\t")]
    [InlineData("hello")]
    public async Task StartTurnStream_AcceptsAnyStringTextDelta(string delta)
    {
        using var httpClient = CreateHttpClient(
            "assistant_text_delta",
            CreatePayload("assistant_text_delta", delta: delta));
        var client = new AgentServiceClient(httpClient);

        List<AgentTurnStreamEvent> events = await ReadEventsAsync(client);

        AgentAssistantTextDelta textDelta = Assert.IsType<AgentAssistantTextDelta>(Assert.Single(events));
        Assert.Equal(delta, textDelta.Delta);
    }

    [Theory]
    [InlineData("assistant_text_delta", "type")]
    [InlineData("turn_failed", "message")]
    [InlineData("tool_started", "callId")]
    [InlineData("tool_started", "name")]
    public async Task StartTurnStream_RejectsWhitespaceInRequiredStringFields(
        string eventName,
        string invalidField)
    {
        using var httpClient = CreateHttpClient(
            eventName,
            CreatePayload(eventName, invalidField: invalidField));
        var client = new AgentServiceClient(httpClient);

        InvalidDataException exception = await Assert.ThrowsAsync<InvalidDataException>(
            () => ReadEventsAsync(client));

        Assert.Contains($"{invalidField} must be a non-empty string.", exception.Message);
    }

    private static HttpClient CreateHttpClient(string eventName, string payload) => new(new SseHandler(eventName, payload))
    {
        BaseAddress = new Uri("http://agent-service.test/"),
    };

    private static async Task<List<AgentTurnStreamEvent>> ReadEventsAsync(AgentServiceClient client)
    {
        var events = new List<AgentTurnStreamEvent>();
        await foreach (AgentTurnStreamEvent streamEvent in client.StartTurnStreamAsync(
            SessionId,
            new AgentTurnRequest("inspect workbook", null),
            CancellationToken.None))
        {
            events.Add(streamEvent);
        }

        return events;
    }

    private static string CreatePayload(
        string eventName,
        string? delta = null,
        string? invalidField = null)
    {
        var payload = new Dictionary<string, object?>
        {
            ["type"] = eventName,
            ["turnId"] = TurnId,
            ["sessionId"] = SessionId,
            ["sequence"] = 0,
            ["timestamp"] = "2026-09-09T12:00:00.0000000+00:00",
        };

        if (eventName == "assistant_text_delta")
        {
            payload["delta"] = delta;
        }
        else if (eventName == "turn_failed")
        {
            payload["message"] = "Turn failed.";
        }
        else if (eventName == "tool_started")
        {
            payload["callId"] = "call-1";
            payload["name"] = "read_workbook";
        }

        if (invalidField is not null)
        {
            payload[invalidField] = " ";
        }

        return JsonSerializer.Serialize(payload);
    }

    private sealed class SseHandler(string eventName, string payload) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            Assert.Equal(HttpMethod.Post, request.Method);
            Assert.Equal($"/sessions/{SessionId:D}/turns/stream", request.RequestUri?.AbsolutePath);

            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(
                    $"id: 0\nevent: {eventName}\ndata: {payload}\n\n",
                    Encoding.UTF8,
                    "text/event-stream"),
            });
        }
    }
}
