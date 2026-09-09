using System.Net;
using System.Text;
using System.Text.Json;
using OpsPilot.Application.Abstractions.AgentService;
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
}
