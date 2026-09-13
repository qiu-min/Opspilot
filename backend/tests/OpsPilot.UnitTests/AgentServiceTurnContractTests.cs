using System.Net;
using System.Text;
using System.Text.Json;
using OpsPilot.Application.Abstractions.AgentService;
using OpsPilot.Application.Exceptions;
using OpsPilot.Infrastructure.AgentService;

namespace OpsPilot.UnitTests;

public sealed class AgentServiceTurnContractTests
{
    private static readonly Guid SessionId = Guid.Parse("55555555-5555-4555-8555-555555555555");
    private static readonly Guid TurnId = Guid.Parse("66666666-6666-4666-8666-666666666666");
    private static readonly Guid FileId = Guid.Parse("77777777-7777-4777-8777-777777777777");

    [Fact]
    public async Task StartTurnStream_SerializesTheExcelResourceContract()
    {
        var handler = new CapturingHandler();
        using var httpClient = new HttpClient(handler)
        {
            BaseAddress = new Uri("http://agent-service.test/"),
        };
        var client = new AgentServiceClient(httpClient);

        var events = new List<AgentTurnStreamEvent>();
        await foreach (AgentTurnStreamEvent streamEvent in client.StartTurnStreamAsync(
            SessionId,
            new AgentTurnRequest(
                "inspect workbook",
                new AgentExcelResource(FileId, "uploads/book.xlsx")),
            CancellationToken.None))
        {
            events.Add(streamEvent);
        }

        using JsonDocument body = JsonDocument.Parse(handler.RequestBody!);
        JsonElement excelResource = body.RootElement.GetProperty("excelResource");
        Assert.Equal("inspect workbook", body.RootElement.GetProperty("message").GetString());
        Assert.Equal(FileId, excelResource.GetProperty("id").GetGuid());
        Assert.Equal("uploads/book.xlsx", excelResource.GetProperty("storagePath").GetString());
        Assert.DoesNotContain("filePath", handler.RequestBody, StringComparison.Ordinal);
        Assert.Collection(events, streamEvent => Assert.IsType<AgentTurnStarted>(streamEvent));
    }

    [Fact]
    public async Task RunTurn_OmitsExcelResourceWhenNoFileWasAttached()
    {
        var handler = new JsonCapturingHandler();
        using var httpClient = new HttpClient(handler)
        {
            BaseAddress = new Uri("http://agent-service.test/"),
        };
        var client = new AgentServiceClient(httpClient);

        AgentTurnResult result = await client.RunTurnAsync(
            SessionId,
            new AgentTurnRequest("hello", null),
            CancellationToken.None);

        using JsonDocument body = JsonDocument.Parse(handler.RequestBody!);
        Assert.False(body.RootElement.TryGetProperty("excelResource", out _));
        Assert.Equal(SessionId, result.SessionId);
    }

    [Fact]
    public async Task GetTurnTrace_DeserializesAllTraceSpanKinds()
    {
        using var httpClient = new HttpClient(new TraceHandler())
        {
            BaseAddress = new Uri("http://agent-service.test/"),
        };
        var client = new AgentServiceClient(httpClient);

        AgentTurnTrace trace = await client.GetTurnTraceAsync(TurnId, CancellationToken.None);

        Assert.Equal(TurnId, trace.TurnId);
        Assert.Equal(SessionId, trace.SessionId);
        Assert.Equal("completed", trace.Status);
        Assert.Equal(5000, trace.DurationMs);
        Assert.Collection(
            trace.Spans,
            span =>
            {
                var model = Assert.IsType<AgentModelTraceSpan>(span);
                Assert.Equal("model-call-A", model.ModelCallId);
                Assert.Equal(140, model.Usage!.TotalTokens);
            },
            span =>
            {
                var tool = Assert.IsType<AgentToolTraceSpan>(span);
                Assert.Equal("call-1", tool.CallId);
                Assert.False(tool.IsError);
            },
            span =>
            {
                var compaction = Assert.IsType<AgentCompactionTraceSpan>(span);
                Assert.Equal("entry-1", compaction.EntryId);
                Assert.Equal("leaf-1", compaction.SessionLeafId);
            });
    }

    [Fact]
    public async Task GetTurnTrace_MapsAgentNotFoundToApplicationNotFound()
    {
        using var httpClient = new HttpClient(new NotFoundHandler())
        {
            BaseAddress = new Uri("http://agent-service.test/"),
        };
        var client = new AgentServiceClient(httpClient);

        await Assert.ThrowsAsync<ApplicationNotFoundException>(() => client.GetTurnTraceAsync(
            TurnId,
            CancellationToken.None));
    }

    private sealed class CapturingHandler : HttpMessageHandler
    {
        public string? RequestBody { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            Assert.Equal(HttpMethod.Post, request.Method);
            Assert.Equal($"/sessions/{SessionId:D}/turns/stream", request.RequestUri?.AbsolutePath);
            RequestBody = await request.Content!.ReadAsStringAsync(cancellationToken);

            string timestamp = "2026-09-09T12:00:00.0000000+00:00";
            string payload = $$"""
                {"type":"turn_started","turnId":"{{TurnId:D}}","sessionId":"{{SessionId:D}}","sequence":0,"timestamp":"{{timestamp}}"}
                """;
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(
                    $"id: 0\nevent: turn_started\ndata: {payload}\n\n",
                    Encoding.UTF8,
                    "text/event-stream"),
            };
        }
    }

    private sealed class JsonCapturingHandler : HttpMessageHandler
    {
        public string? RequestBody { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            Assert.Equal(HttpMethod.Post, request.Method);
            Assert.Equal($"/sessions/{SessionId:D}/turns", request.RequestUri?.AbsolutePath);
            RequestBody = await request.Content!.ReadAsStringAsync(cancellationToken);
            string response = $$"""
                {"sessionId":"{{SessionId:D}}","turnId":"{{TurnId:D}}","leafId":null,"status":"completed","output":"done"}
                """;
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(response, Encoding.UTF8, "application/json"),
            };
        }
    }

    private sealed class TraceHandler : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            Assert.Equal(HttpMethod.Get, request.Method);
            Assert.Equal($"/turns/{TurnId:D}/trace", request.RequestUri?.AbsolutePath);
            string response = $$"""
                {
                  "turnId":"{{TurnId:D}}",
                  "sessionId":"{{SessionId:D}}",
                  "status":"completed",
                  "startedAt":"2026-09-09T12:00:00Z",
                  "endedAt":"2026-09-09T12:00:05Z",
                  "durationMs":5000,
                  "spans":[
                    {
                      "id":"model:model-call-A",
                      "kind":"model",
                      "attempt":1,
                      "status":"completed",
                      "startSequence":1,
                      "endSequence":2,
                      "startedAt":"2026-09-09T12:00:01Z",
                      "endedAt":"2026-09-09T12:00:02Z",
                      "durationMs":1000,
                      "modelCallId":"model-call-A",
                      "usage":{"inputTokens":100,"outputTokens":40,"totalTokens":140}
                    },
                    {
                      "id":"tool:call-1:attempt:1",
                      "kind":"tool",
                      "attempt":1,
                      "status":"completed",
                      "startSequence":4,
                      "endSequence":6,
                      "startedAt":"2026-09-09T12:00:01Z",
                      "endedAt":"2026-09-09T12:00:03Z",
                      "durationMs":2000,
                      "callId":"call-1",
                      "name":"lookup",
                      "requestedAt":"2026-09-09T12:00:00Z",
                      "isError":false
                    },
                    {
                      "id":"compaction:7",
                      "kind":"compaction",
                      "attempt":1,
                      "status":"completed",
                      "startSequence":7,
                      "endSequence":8,
                      "startedAt":"2026-09-09T12:00:03Z",
                      "endedAt":"2026-09-09T12:00:04Z",
                      "durationMs":1000,
                      "entryId":"entry-1",
                      "sessionLeafId":"leaf-1"
                    }
                  ]
                }
                """;
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(response, Encoding.UTF8, "application/json"),
            });
        }
    }

    private sealed class NotFoundHandler : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken) =>
            Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound));
    }
}
