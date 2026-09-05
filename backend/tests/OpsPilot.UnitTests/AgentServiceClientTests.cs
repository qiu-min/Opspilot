using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using OpsPilot.Application.Abstractions.AgentService;
using OpsPilot.Infrastructure.AgentService;

namespace OpsPilot.UnitTests;

public sealed class AgentServiceClientTests
{
    [Fact]
    public async Task GetHistoryAsync_GetsSessionHistoryAndMapsResponse()
    {
        string? requestPath = null;
        string? requestMethod = null;
        var handler = new StubHttpMessageHandler((request, _) =>
        {
            requestMethod = request.Method.Method;
            requestPath = request.RequestUri?.PathAndQuery;
            return Task.FromResult(JsonResponse(new
            {
                leafId = "entry-2",
                items = new[]
                {
                    new
                    {
                        type = "message",
                        id = "entry-1",
                        role = "user",
                        text = "hello",
                        createdAt = "2026-09-05T08:00:00.000Z",
                    },
                    new
                    {
                        type = "message",
                        id = "entry-2",
                        role = "assistant",
                        text = "Hi.",
                        createdAt = "2026-09-05T08:00:01.000Z",
                    },
                },
            }));
        });
        using var httpClient = new HttpClient(handler)
        {
            BaseAddress = new Uri("http://agent-service.test/"),
        };
        var client = new AgentServiceClient(httpClient);
        Guid sessionId = Guid.Parse("11111111-1111-1111-1111-111111111111");

        AgentConversationHistory result = await client.GetHistoryAsync(
            sessionId,
            CancellationToken.None);

        Assert.Equal("GET", requestMethod);
        Assert.Equal($"/sessions/{sessionId:D}/history", requestPath);
        Assert.Equal("entry-2", result.LeafId);
        Assert.Collection(
            result.Items,
            item =>
            {
                Assert.Equal("entry-1", item.Id);
                Assert.Equal("user", item.Role);
                Assert.Equal("hello", item.Text);
            },
            item =>
            {
                Assert.Equal("entry-2", item.Id);
                Assert.Equal("assistant", item.Role);
                Assert.Equal("Hi.", item.Text);
            });
    }

    [Fact]
    public async Task RunTurnAsync_PostsExpectedRequestAndMapsResponse()
    {
        string? requestPath = null;
        string? requestMethod = null;
        string? requestBody = null;
        var handler = new StubHttpMessageHandler(async (request, cancellationToken) =>
        {
            requestMethod = request.Method.Method;
            requestPath = request.RequestUri?.PathAndQuery;
            requestBody = await request.Content!.ReadAsStringAsync(cancellationToken);
            return JsonResponse(new
            {
                sessionId = Guid.Parse("11111111-1111-1111-1111-111111111111"),
                leafId = "leaf-1",
                status = "completed",
                output = "Workbook inspected.",
            });
        });
        using var httpClient = new HttpClient(handler)
        {
            BaseAddress = new Uri("http://agent-service.test/"),
        };
        var client = new AgentServiceClient(httpClient);
        Guid sessionId = Guid.NewGuid();
        using var cancellationSource = new CancellationTokenSource();

        AgentConversationTurnResult result = await client.RunTurnAsync(
            new AgentConversationTurnRequest(
                sessionId,
                "Inspect the workbook.",
                new AgentExcelResource(
                    Guid.Parse("22222222-2222-2222-2222-222222222222"),
                    "uploads/report.xlsx")),
            cancellationSource.Token);

        Assert.Equal("POST", requestMethod);
        Assert.Equal("/conversations/turns", requestPath);
        Assert.NotNull(requestBody);
        using JsonDocument document = JsonDocument.Parse(requestBody!);
        JsonElement body = document.RootElement;
        Assert.Equal(sessionId, body.GetProperty("sessionId").GetGuid());
        Assert.Equal("Inspect the workbook.", body.GetProperty("message").GetString());
        JsonElement resource = body.GetProperty("excelResource");
        Assert.Equal("22222222-2222-2222-2222-222222222222", resource.GetProperty("id").GetString());
        Assert.Equal("uploads/report.xlsx", resource.GetProperty("storagePath").GetString());
        Assert.False(body.TryGetProperty("filePath", out _));
        Assert.False(body.TryGetProperty("physicalPath", out _));
        Assert.False(body.TryGetProperty("storageRoot", out _));
        Assert.Equal(
            Guid.Parse("11111111-1111-1111-1111-111111111111"),
            result.SessionId);
        Assert.Equal("leaf-1", result.LeafId);
        Assert.Equal("completed", result.Status);
        Assert.Equal("Workbook inspected.", result.Output);
    }

    [Fact]
    public async Task RunTurnAsync_WithoutResourceOmitsExcelResourceFromPayload()
    {
        string? requestBody = null;
        var handler = new StubHttpMessageHandler(async (request, cancellationToken) =>
        {
            requestBody = await request.Content!.ReadAsStringAsync(cancellationToken);
            return JsonResponse(new
            {
                sessionId = Guid.NewGuid(),
                leafId = (string?)null,
                status = "completed",
                output = "Hello.",
            });
        });
        using var httpClient = new HttpClient(handler)
        {
            BaseAddress = new Uri("http://agent-service.test/"),
        };
        var client = new AgentServiceClient(httpClient);

        await client.RunTurnAsync(
            new AgentConversationTurnRequest(null, "Hello.", null),
            CancellationToken.None);

        using JsonDocument document = JsonDocument.Parse(requestBody!);
        Assert.False(document.RootElement.TryGetProperty("excelResource", out _));
    }

    [Fact]
    public async Task RunTurnAsync_WhenAgentServiceReturnsFailureThrowsWithoutResponseBody()
    {
        const string sensitiveResponseBody = "provider secret and model output";
        var handler = new StubHttpMessageHandler((_, _) => Task.FromResult(
            new HttpResponseMessage(HttpStatusCode.BadRequest)
            {
                Content = new StringContent(sensitiveResponseBody),
            }));
        using var httpClient = new HttpClient(handler)
        {
            BaseAddress = new Uri("http://agent-service.test/"),
        };
        var client = new AgentServiceClient(httpClient);

        HttpRequestException exception = await Assert.ThrowsAsync<HttpRequestException>(() =>
            client.RunTurnAsync(
                new AgentConversationTurnRequest(null, "Hello.", null),
                CancellationToken.None));

        Assert.DoesNotContain(sensitiveResponseBody, exception.Message);
    }

    [Fact]
    public async Task RunTurnAsync_PropagatesCancellationToken()
    {
        using var cancellationSource = new CancellationTokenSource();
        var handler = new StubHttpMessageHandler((_, cancellationToken) =>
        {
            cancellationToken.ThrowIfCancellationRequested();
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK));
        });
        using var httpClient = new HttpClient(handler)
        {
            BaseAddress = new Uri("http://agent-service.test/"),
        };
        var client = new AgentServiceClient(httpClient);
        cancellationSource.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            client.RunTurnAsync(
                new AgentConversationTurnRequest(null, "Hello.", null),
                cancellationSource.Token));
    }

    private static HttpResponseMessage JsonResponse<T>(T value)
    {
        return new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = JsonContent.Create(value),
        };
    }

    private sealed class StubHttpMessageHandler(
        Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> send)
        : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            return send(request, cancellationToken);
        }
    }
}
