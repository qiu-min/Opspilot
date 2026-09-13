using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Runtime.CompilerServices;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using OpsPilot.Api.Features.Auth.Contracts.Responses;
using OpsPilot.Application.Abstractions.AgentService;
using OpsPilot.IntegrationTests.Infrastructure;

namespace OpsPilot.IntegrationTests;

public sealed class SessionEndpointTests : IClassFixture<SessionTestFactory>
{
    private readonly SessionTestFactory factory;
    private readonly HttpClient httpClient;

    public SessionEndpointTests(SessionTestFactory factory)
    {
        this.factory = factory;
        httpClient = factory.CreateClient();
    }

    [Fact]
    public async Task CreateListAndDetail_UseOneSessionIdentity()
    {
        LoginResponse login = await RegisterAndLoginAsync();
        Guid expectedSessionId = factory.Agent.NextSessionId;

        using HttpResponseMessage createResponse = await SendAsync(HttpMethod.Post, "/api/sessions", login.AccessToken);
        Assert.Equal(HttpStatusCode.Created, createResponse.StatusCode);
        JsonElement created = await createResponse.Content.ReadFromJsonAsync<JsonElement>();
        Guid sessionId = created.GetProperty("id").GetGuid();
        Assert.Equal(expectedSessionId, sessionId);
        Guid historicalTurnId = Guid.NewGuid();

        factory.Agent.Histories[sessionId] = new AgentSessionHistory("leaf", [
            new AgentSessionHistoryMessageItem("message-1", "user", "inspect", DateTimeOffset.UtcNow),
            new AgentSessionHistoryToolExecutionItem("tool-1", "call-1", "lookup", "completed", DateTimeOffset.UtcNow),
        ], [
            new AgentTurnPresentationSummary(
                historicalTurnId,
                sessionId,
                "message-1",
                "completed",
                DateTimeOffset.Parse("2026-09-09T12:00:00Z"),
                DateTimeOffset.Parse("2026-09-09T12:00:05Z"),
                new AgentTurnPresentationUsage(100, 40, 140),
                [new AgentTurnToolPresentationSummary(
                    "call-1",
                    "lookup",
                    "completed",
                    new AgentToolDisplayInfo("Look up", "record-1", "Reading record"),
                    DateTimeOffset.Parse("2026-09-09T12:00:01Z"),
                    DateTimeOffset.Parse("2026-09-09T12:00:02Z"))])
        ]);

        using HttpResponseMessage listResponse = await SendAsync(HttpMethod.Get, "/api/sessions", login.AccessToken);
        Assert.Equal(HttpStatusCode.OK, listResponse.StatusCode);
        JsonElement[] sessions = await listResponse.Content.ReadFromJsonAsync<JsonElement[]>() ?? [];
        Assert.Contains(sessions, item => item.GetProperty("id").GetGuid() == sessionId);

        using HttpResponseMessage detailResponse = await SendAsync(HttpMethod.Get, $"/api/sessions/{sessionId}", login.AccessToken);
        Assert.Equal(HttpStatusCode.OK, detailResponse.StatusCode);
        JsonElement detail = await detailResponse.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(sessionId, detail.GetProperty("id").GetGuid());
        Assert.Equal(2, detail.GetProperty("items").GetArrayLength());
        JsonElement summary = Assert.Single(detail.GetProperty("turnSummaries").EnumerateArray());
        Assert.Equal(historicalTurnId, summary.GetProperty("turnId").GetGuid());
        Assert.Equal("message-1", summary.GetProperty("inputEntryId").GetString());
        Assert.Equal("completed", summary.GetProperty("status").GetString());
        Assert.Equal(140, summary.GetProperty("usage").GetProperty("totalTokens").GetInt32());
        Assert.Equal("Look up", summary.GetProperty("tools")[0].GetProperty("display").GetProperty("title").GetString());
        Assert.Equal("record-1", summary.GetProperty("tools")[0].GetProperty("display").GetProperty("subject").GetString());
        Assert.Equal("Reading record", summary.GetProperty("tools")[0].GetProperty("display").GetProperty("detail").GetString());
        Assert.Equal(DateTimeOffset.Parse("2026-09-09T12:00:01Z"), summary.GetProperty("tools")[0].GetProperty("startedAt").GetDateTimeOffset());
        Assert.Equal(DateTimeOffset.Parse("2026-09-09T12:00:02Z"), summary.GetProperty("tools")[0].GetProperty("completedAt").GetDateTimeOffset());
    }

    [Fact]
    public async Task RunTurn_UsesRouteSessionId()
    {
        LoginResponse login = await RegisterAndLoginAsync();
        Guid sessionId = await CreateSessionAsync(login.AccessToken);
        factory.Agent.RunResult = new AgentTurnResult(sessionId, Guid.NewGuid(), "leaf", "completed", "done");

        using HttpRequestMessage request = new(HttpMethod.Post, $"/api/sessions/{sessionId}/turns")
        {
            Content = JsonContent.Create(new { message = "inspect" }),
        };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", login.AccessToken);
        using HttpResponseMessage response = await httpClient.SendAsync(request);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(sessionId, factory.Agent.LastRunSessionId);
        JsonElement body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(sessionId, body.GetProperty("sessionId").GetGuid());
    }

    [Fact]
    public async Task Trace_ReturnsModelToolAndCompactionSpansWithoutReprojection()
    {
        LoginResponse login = await RegisterAndLoginAsync();
        Guid sessionId = await CreateSessionAsync(login.AccessToken);
        Guid turnId = Guid.NewGuid();
        DateTimeOffset startedAt = DateTimeOffset.Parse("2026-09-09T12:00:00Z");
        factory.Agent.Traces[turnId] = new AgentTurnTrace(
            turnId,
            sessionId,
            "completed",
            startedAt,
            startedAt.AddSeconds(5),
            5000,
            [
                new AgentModelTraceSpan(
                    "model:model-call-A",
                    1,
                    "completed",
                    1,
                    2,
                    startedAt.AddSeconds(1),
                    startedAt.AddSeconds(2),
                    1000,
                    "model-call-A",
                    new AgentModelTraceUsage(100, 40, 140))
                {
                    Retries =
                    [
                        new AgentModelRetryTrace(
                            1,
                            2,
                            500,
                            new AgentModelTraceError(
                                "rate_limit",
                                "MODEL_RATE_LIMIT",
                                "Model provider rate limit exceeded.",
                                true,
                                429,
                                "provider_rate_limit"),
                            startedAt.AddMilliseconds(500)),
                    ],
                },
                new AgentToolTraceSpan(
                    "tool:call-1:attempt:1",
                    1,
                    "completed",
                    4,
                    6,
                    startedAt.AddSeconds(1),
                    startedAt.AddSeconds(3),
                    2000,
                    "call-1",
                    "lookup",
                    startedAt,
                    false),
                new AgentCompactionTraceSpan(
                    "compaction:7",
                    1,
                    "completed",
                    7,
                    8,
                    startedAt.AddSeconds(3),
                    startedAt.AddSeconds(4),
                    1000,
                    "entry-1",
                    "leaf-1"),
            ]);

        using HttpResponseMessage response = await SendAsync(
            HttpMethod.Get,
            $"/api/sessions/{sessionId}/turns/{turnId}/trace",
            login.AccessToken);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        JsonElement body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(turnId, body.GetProperty("turnId").GetGuid());
        Assert.Equal(sessionId, body.GetProperty("sessionId").GetGuid());
        Assert.Equal("completed", body.GetProperty("status").GetString());
        Assert.Equal(5000, body.GetProperty("durationMs").GetInt64());

        JsonElement[] spans = body.GetProperty("spans").EnumerateArray().ToArray();
        Assert.Equal(["model", "tool", "compaction"], spans.Select(span => span.GetProperty("kind").GetString()!).ToArray());
        Assert.Equal("model-call-A", spans[0].GetProperty("modelCallId").GetString());
        Assert.Equal(140, spans[0].GetProperty("usage").GetProperty("totalTokens").GetInt32());
        Assert.True(spans[0].GetProperty("error").ValueKind == JsonValueKind.Null);
        JsonElement retry = Assert.Single(spans[0].GetProperty("retries").EnumerateArray());
        Assert.Equal(1, retry.GetProperty("failedAttempt").GetInt32());
        Assert.Equal(2, retry.GetProperty("nextAttempt").GetInt32());
        Assert.Equal(500, retry.GetProperty("delayMs").GetInt32());
        Assert.Equal("rate_limit", retry.GetProperty("error").GetProperty("kind").GetString());
        Assert.Equal(429, retry.GetProperty("error").GetProperty("statusCode").GetInt32());
        Assert.Equal(1, spans[0].GetProperty("attempt").GetInt32());
        Assert.Equal("lookup", spans[1].GetProperty("name").GetString());
        Assert.Equal("call-1", spans[1].GetProperty("callId").GetString());
        Assert.False(spans[1].GetProperty("isError").GetBoolean());
        Assert.Equal("entry-1", spans[2].GetProperty("entryId").GetString());
        Assert.Equal("leaf-1", spans[2].GetProperty("sessionLeafId").GetString());
    }

    [Theory]
    [InlineData("running")]
    [InlineData("failed")]
    [InlineData("cancelled")]
    public async Task Trace_ReturnsOkForEveryTurnStatus(string status)
    {
        LoginResponse login = await RegisterAndLoginAsync();
        Guid sessionId = await CreateSessionAsync(login.AccessToken);
        Guid turnId = Guid.NewGuid();
        factory.Agent.Traces[turnId] = new AgentTurnTrace(
            turnId,
            sessionId,
            status,
            null,
            null,
            null,
            []);

        using HttpResponseMessage response = await SendAsync(
            HttpMethod.Get,
            $"/api/sessions/{sessionId}/turns/{turnId}/trace",
            login.AccessToken);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        JsonElement body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(status, body.GetProperty("status").GetString());
    }

    [Fact]
    public async Task Trace_WhenAgentTurnDoesNotExistReturnsNotFound()
    {
        LoginResponse login = await RegisterAndLoginAsync();
        Guid sessionId = await CreateSessionAsync(login.AccessToken);
        Guid turnId = Guid.NewGuid();

        using HttpResponseMessage response = await SendAsync(
            HttpMethod.Get,
            $"/api/sessions/{sessionId}/turns/{turnId}/trace",
            login.AccessToken);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task Trace_WhenAgentSessionDoesNotMatchRouteReturnsNotFound()
    {
        LoginResponse login = await RegisterAndLoginAsync();
        Guid sessionId = await CreateSessionAsync(login.AccessToken);
        Guid turnId = Guid.NewGuid();
        factory.Agent.Traces[turnId] = new AgentTurnTrace(
            turnId,
            Guid.NewGuid(),
            "completed",
            null,
            null,
            null,
            []);

        using HttpResponseMessage response = await SendAsync(
            HttpMethod.Get,
            $"/api/sessions/{sessionId}/turns/{turnId}/trace",
            login.AccessToken);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task Detail_OmitsNullHistoricalToolPresentationFields()
    {
        LoginResponse login = await RegisterAndLoginAsync();
        Guid sessionId = await CreateSessionAsync(login.AccessToken);
        factory.Agent.Histories[sessionId] = new AgentSessionHistory("leaf", [
            new AgentSessionHistoryMessageItem("message-1", "user", "lookup", DateTimeOffset.UtcNow),
        ], [
            new AgentTurnPresentationSummary(
                Guid.NewGuid(),
                sessionId,
                "message-1",
                "completed",
                DateTimeOffset.Parse("2026-09-09T12:00:00Z"),
                DateTimeOffset.Parse("2026-09-09T12:00:05Z"),
                null,
                [new AgentTurnToolPresentationSummary(
                    "call-1",
                    "lookup",
                    "completed",
                    null,
                    null,
                    DateTimeOffset.Parse("2026-09-09T12:00:02Z"))])
        ]);

        using HttpResponseMessage response = await SendAsync(HttpMethod.Get, $"/api/sessions/{sessionId}", login.AccessToken);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        JsonElement tool = (await response.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("turnSummaries")[0]
            .GetProperty("tools")[0];

        Assert.False(tool.TryGetProperty("display", out _));
        Assert.False(tool.TryGetProperty("startedAt", out _));
        Assert.Equal(DateTimeOffset.Parse("2026-09-09T12:00:02Z"), tool.GetProperty("completedAt").GetDateTimeOffset());
    }

    [Fact]
    public async Task Stream_ForwardsPr2TurnStreamEventsWithoutSemanticReprojection()
    {
        LoginResponse login = await RegisterAndLoginAsync();
        Guid sessionId = await CreateSessionAsync(login.AccessToken);
        Guid turnId = Guid.NewGuid();
        factory.Agent.StartEvents = [
            new AgentTurnStarted(turnId, sessionId, 0, DateTimeOffset.UtcNow),
            new AgentModelRetry(turnId, sessionId, 1, DateTimeOffset.UtcNow, "model-call-1", 1, 2, 500, "rate_limit"),
            new AgentAssistantTextDelta(turnId, sessionId, 2, DateTimeOffset.UtcNow, "hello"),
            new AgentTurnCompleted(turnId, sessionId, 3, DateTimeOffset.UtcNow, "leaf"),
        ];

        using HttpRequestMessage request = new(HttpMethod.Post, $"/api/sessions/{sessionId}/turns/stream")
        {
            Content = JsonContent.Create(new { message = "inspect" }),
        };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", login.AccessToken);
        using HttpResponseMessage response = await httpClient.SendAsync(request);
        string body = await response.Content.ReadAsStringAsync();

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Contains("id: 0", body, StringComparison.Ordinal);
        Assert.Contains("id: 1", body, StringComparison.Ordinal);
        Assert.Contains("event: model_retry", body, StringComparison.Ordinal);
        Assert.Contains("\"modelCallId\":\"model-call-1\"", body, StringComparison.Ordinal);
        Assert.Contains("\"failedAttempt\":1", body, StringComparison.Ordinal);
        Assert.Contains("\"nextAttempt\":2", body, StringComparison.Ordinal);
        Assert.Contains("\"delayMs\":500", body, StringComparison.Ordinal);
        Assert.Contains("\"kind\":\"rate_limit\"", body, StringComparison.Ordinal);
        Assert.Contains("event: assistant_text_delta", body, StringComparison.Ordinal);
        Assert.Contains("\"type\":\"assistant_text_delta\"", body, StringComparison.Ordinal);
        Assert.DoesNotContain("response_started", body, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ActiveTurn_ReturnsAgentProjection()
    {
        LoginResponse login = await RegisterAndLoginAsync();
        Guid sessionId = await CreateSessionAsync(login.AccessToken);
        Guid turnId = Guid.NewGuid();
        factory.Agent.ActiveTurns[sessionId] = new AgentActiveTurnSnapshot(
            turnId,
            sessionId,
            "running",
            new AgentTurnStreamProjection(turnId, sessionId, "running", new AgentTurnAssistantProjection("partial", true, false), [new AgentTurnToolProjection("call-1", "lookup", "completed", new AgentToolDisplayInfo("Look up", "record-1", "Reading record"), "2026-09-09T12:00:01Z", "2026-09-09T12:00:02Z")], new AgentTurnCompactionProjection("idle"), null, 7, "2026-09-09T12:00:00Z", new AgentTurnRetryProjection("model-call-1", 1, 2, 500, "rate_limit")));

        using HttpResponseMessage response = await SendAsync(HttpMethod.Get, $"/api/sessions/{sessionId}/active-turn", login.AccessToken);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        JsonElement body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(turnId, body.GetProperty("activeTurn").GetProperty("turnId").GetGuid());
        Assert.Equal(7, body.GetProperty("activeTurn").GetProperty("projection").GetProperty("lastSequence").GetInt64());
        Assert.Equal("2026-09-09T12:00:00Z", body.GetProperty("activeTurn").GetProperty("projection").GetProperty("startedAt").GetString());
        JsonElement retry = body.GetProperty("activeTurn").GetProperty("projection").GetProperty("retry");
        Assert.Equal("model-call-1", retry.GetProperty("modelCallId").GetString());
        Assert.Equal(1, retry.GetProperty("failedAttempt").GetInt32());
        Assert.Equal(2, retry.GetProperty("nextAttempt").GetInt32());
        Assert.Equal(500, retry.GetProperty("delayMs").GetInt32());
        Assert.Equal("rate_limit", retry.GetProperty("kind").GetString());
        Assert.Equal("2026-09-09T12:00:01Z", body.GetProperty("activeTurn").GetProperty("projection").GetProperty("tools")[0].GetProperty("startedAt").GetString());
        Assert.Equal("2026-09-09T12:00:02Z", body.GetProperty("activeTurn").GetProperty("projection").GetProperty("tools")[0].GetProperty("completedAt").GetString());
        Assert.Equal("Look up", body.GetProperty("activeTurn").GetProperty("projection").GetProperty("tools")[0].GetProperty("display").GetProperty("title").GetString());
    }

    [Fact]
    public async Task Reattach_ForwardsAfterAndDoesNotStartAnotherTurn()
    {
        LoginResponse login = await RegisterAndLoginAsync();
        Guid sessionId = await CreateSessionAsync(login.AccessToken);
        Guid turnId = Guid.NewGuid();
        factory.Agent.ActiveTurns[sessionId] = new AgentActiveTurnSnapshot(
            turnId,
            sessionId,
            "running",
            new AgentTurnStreamProjection(turnId, sessionId, "running", new AgentTurnAssistantProjection("partial", true, false), [], new AgentTurnCompactionProjection("idle"), null, 20));
        factory.Agent.ReattachEvents = [new AgentAssistantTextDelta(turnId, sessionId, 21, DateTimeOffset.UtcNow, "continued")];
        int runCallsBefore = factory.Agent.RunTurnCalls;

        using HttpResponseMessage response = await SendAsync(HttpMethod.Get, $"/api/sessions/{sessionId}/turns/{turnId}/stream?after=20", login.AccessToken);
        string body = await response.Content.ReadAsStringAsync();

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Contains("id: 21", body, StringComparison.Ordinal);
        Assert.Equal(20, factory.Agent.LastAfterSequence);
        Assert.Equal(runCallsBefore, factory.Agent.RunTurnCalls);
    }

    [Fact]
    public async Task AnotherUserCannotReadOrReattachSomebodyElsesSession()
    {
        LoginResponse owner = await RegisterAndLoginAsync();
        LoginResponse other = await RegisterAndLoginAsync();
        Guid sessionId = await CreateSessionAsync(owner.AccessToken);
        Guid turnId = Guid.NewGuid();
        int traceCallsBefore = factory.Agent.TraceCalls;

        using HttpResponseMessage detail = await SendAsync(HttpMethod.Get, $"/api/sessions/{sessionId}", other.AccessToken);
        using HttpResponseMessage reattach = await SendAsync(HttpMethod.Get, $"/api/sessions/{sessionId}/turns/{turnId}/stream?after=0", other.AccessToken);
        using HttpResponseMessage trace = await SendAsync(HttpMethod.Get, $"/api/sessions/{sessionId}/turns/{turnId}/trace", other.AccessToken);

        Assert.Equal(HttpStatusCode.NotFound, detail.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, reattach.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, trace.StatusCode);
        Assert.Equal(traceCallsBefore, factory.Agent.TraceCalls);
    }

    private async Task<Guid> CreateSessionAsync(string token)
    {
        using HttpResponseMessage response = await SendAsync(HttpMethod.Post, "/api/sessions", token);
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        JsonElement body = await response.Content.ReadFromJsonAsync<JsonElement>();
        return body.GetProperty("id").GetGuid();
    }

    private async Task<LoginResponse> RegisterAndLoginAsync()
    {
        string email = $"session-{Guid.NewGuid():N}@example.com";
        const string password = "Password123!";
        using HttpResponseMessage register = await httpClient.PostAsJsonAsync("/api/auth/register", new { email, password });
        Assert.Equal(HttpStatusCode.Created, register.StatusCode);
        using HttpResponseMessage login = await httpClient.PostAsJsonAsync("/api/auth/login", new { email, password });
        Assert.Equal(HttpStatusCode.OK, login.StatusCode);
        return (await login.Content.ReadFromJsonAsync<LoginResponse>())!;
    }

    private Task<HttpResponseMessage> SendAsync(HttpMethod method, string path, string token)
    {
        var request = new HttpRequestMessage(method, path);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        return httpClient.SendAsync(request);
    }
}

public sealed class SessionTestFactory : WebApplicationFactory<Program>
{
    private readonly PostgresTestDatabase postgresDatabase = new();
    public FakeAgentSessionClient Agent { get; } = new();

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Testing");
        builder.UseSetting("ConnectionStrings:Postgres", postgresDatabase.ConnectionString);
        builder.UseSetting("AgentService:BaseUrl", "http://127.0.0.1:3000");
        builder.UseSetting("Jwt:SigningKey", TestJwtConfiguration.SigningKey);
        builder.ConfigureLogging(logging => logging.ClearProviders());
        builder.ConfigureServices(services =>
        {
            services.RemoveAll<IAgentSessionClient>();
            services.AddSingleton<IAgentSessionClient>(Agent);
        });
    }

    protected override IHost CreateHost(IHostBuilder builder)
    {
        postgresDatabase.Initialize();
        IHost host = base.CreateHost(builder);
        using IServiceScope scope = host.Services.CreateScope();
        postgresDatabase.Migrate(scope.ServiceProvider.GetRequiredService<OpsPilot.Infrastructure.Persistence.OpsPilotDbContext>());
        return host;
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        if (disposing) postgresDatabase.Dispose();
    }
}

public sealed class FakeAgentSessionClient : IAgentSessionClient
{
    private int sessionSequence;
    public Guid NextSessionId => Guid.Parse($"88888888-8888-4888-8888-{(sessionSequence + 1):D12}");
    public Dictionary<Guid, AgentSessionHistory> Histories { get; } = [];
    public Dictionary<Guid, AgentTurnTrace> Traces { get; } = [];
    public Dictionary<Guid, AgentActiveTurnSnapshot> ActiveTurns { get; } = [];
    public IReadOnlyList<AgentTurnStreamEvent> StartEvents { get; set; } = [];
    public IReadOnlyList<AgentTurnStreamEvent> ReattachEvents { get; set; } = [];
    public AgentTurnResult RunResult { get; set; } = new(Guid.Empty, Guid.NewGuid(), null, "completed", "done");
    public Guid? LastRunSessionId { get; private set; }
    public long? LastAfterSequence { get; private set; }
    public int RunTurnCalls { get; private set; }
    public int TraceCalls { get; private set; }

    public Task<AgentSessionCreated> CreateSessionAsync(CancellationToken cancellationToken)
    {
        Guid id = Guid.Parse($"88888888-8888-4888-8888-{(++sessionSequence):D12}");
        DateTimeOffset now = DateTimeOffset.UtcNow;
        return Task.FromResult(new AgentSessionCreated(id, now, now));
    }

    public Task<AgentSessionHistory> GetHistoryAsync(Guid sessionId, CancellationToken cancellationToken) =>
        Task.FromResult(Histories.GetValueOrDefault(sessionId, new AgentSessionHistory(null, [])));

    public Task<AgentTurnTrace> GetTurnTraceAsync(Guid turnId, CancellationToken cancellationToken)
    {
        TraceCalls++;
        if (!Traces.TryGetValue(turnId, out AgentTurnTrace? trace))
            throw new OpsPilot.Application.Exceptions.ApplicationNotFoundException("Agent Service resource was not found.");
        return Task.FromResult(trace);
    }

    public Task<AgentTurnResult> RunTurnAsync(Guid sessionId, AgentTurnRequest request, CancellationToken cancellationToken)
    {
        LastRunSessionId = sessionId;
        RunTurnCalls++;
        return Task.FromResult(RunResult with { SessionId = sessionId });
    }

    public IAsyncEnumerable<AgentTurnStreamEvent> StartTurnStreamAsync(Guid sessionId, AgentTurnRequest request, CancellationToken cancellationToken) => Yield(StartEvents, cancellationToken);

    public Task<AgentActiveTurnSnapshot?> GetActiveTurnAsync(Guid sessionId, CancellationToken cancellationToken) =>
        Task.FromResult(ActiveTurns.GetValueOrDefault(sessionId));

    public IAsyncEnumerable<AgentTurnStreamEvent> ReattachTurnStreamAsync(Guid turnId, long? afterSequence, CancellationToken cancellationToken)
    {
        LastAfterSequence = afterSequence;
        return Yield(ReattachEvents, cancellationToken);
    }

    private static async IAsyncEnumerable<AgentTurnStreamEvent> Yield(IEnumerable<AgentTurnStreamEvent> events, [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        foreach (AgentTurnStreamEvent streamEvent in events)
        {
            cancellationToken.ThrowIfCancellationRequested();
            yield return streamEvent;
            await Task.Yield();
        }
    }
}
