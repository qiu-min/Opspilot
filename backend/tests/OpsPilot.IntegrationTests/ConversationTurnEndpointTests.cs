using System.Net;
using System.Net.Http.Json;
using System.Security.Claims;
using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;
using OpsPilot.Application.Abstractions.AgentService;
using OpsPilot.Application.Abstractions.Persistence;
using OpsPilot.Application.Abstractions.Security;
using OpsPilot.Domain.Conversations;
using OpsPilot.Domain.Files;
using OpsPilot.IntegrationTests.Infrastructure;

namespace OpsPilot.IntegrationTests;

public sealed class ConversationTurnEndpointTests : IClassFixture<ConversationTestFactory>
{
    private readonly ConversationTestFactory factory;
    private readonly HttpClient httpClient;

    public ConversationTurnEndpointTests(ConversationTestFactory factory)
    {
        this.factory = factory;
        httpClient = factory.CreateClient();
    }

    [Fact]
    public async Task PostTurn_WithFileIdForwardsFileResourceBindsSessionAndHidesSessionId()
    {
        Conversation conversation = CreateConversation(factory.CurrentUserId);
        FileAsset fileAsset = CreateFileAsset(factory.CurrentUserId);
        factory.Conversation = conversation;
        factory.FileAsset = fileAsset;
        factory.ConversationRepository.Reset();
        factory.FileAssetRepository.Reset();
        factory.AgentClient.Reset();
        using HttpResponseMessage response = await httpClient.PostAsJsonAsync(
            $"/api/conversations/{conversation.Id}/turns",
            new
            {
                fileId = fileAsset.Id,
                message = "Which sheets are in this workbook?",
            });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        ConversationResponse? body = await response.Content.ReadFromJsonAsync<ConversationResponse>();
        Assert.NotNull(body);
        Assert.Equal(conversation.Id, body!.ConversationId);
        Assert.Equal(factory.AgentClient.Result.LeafId, body.LeafId);
        Assert.Equal(factory.AgentClient.Result.Status, body.Status);
        Assert.Equal(factory.AgentClient.Result.Output, body.Output);
        string responseBody = await response.Content.ReadAsStringAsync();
        Assert.DoesNotContain("sessionId", responseBody, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("agentSessionId", responseBody, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("userId", responseBody, StringComparison.OrdinalIgnoreCase);
        Assert.Equal(
            new AgentConversationTurnRequest(
                null,
                "Which sheets are in this workbook?",
                new AgentExcelResource(fileAsset.Id, fileAsset.StoragePath)),
            factory.AgentClient.Request);
        Assert.Equal(factory.AgentClient.Result.SessionId, conversation.AgentSessionId);
        Assert.Equal(1, factory.ConversationRepository.SaveChangesCallCount);
    }

    [Fact]
    public async Task PostTurn_TwiceReusesBoundSession()
    {
        Conversation conversation = CreateConversation(factory.CurrentUserId);
        factory.Conversation = conversation;
        factory.FileAsset = null;
        factory.ConversationRepository.Reset();
        factory.AgentClient.Reset();

        using HttpResponseMessage firstResponse = await PostTurnAsync(
            conversation.Id,
            new { message = "Hello." });

        Assert.Equal(HttpStatusCode.OK, firstResponse.StatusCode);
        Guid sessionId = factory.AgentClient.Result.SessionId;
        Assert.Equal(sessionId, conversation.AgentSessionId);

        factory.ConversationRepository.Reset();
        factory.AgentClient.Reset();

        using HttpResponseMessage secondResponse = await PostTurnAsync(
            conversation.Id,
            new { message = "Continue." });

        Assert.Equal(HttpStatusCode.OK, secondResponse.StatusCode);
        Assert.Equal(
            new AgentConversationTurnRequest(sessionId, "Continue.", null),
            factory.AgentClient.Request);
        Assert.Equal(sessionId, conversation.AgentSessionId);
        Assert.Equal(1, factory.ConversationRepository.SaveChangesCallCount);
    }

    [Fact]
    public async Task PostTurn_WhenAgentReturnsDifferentSessionReturnsServerErrorWithoutSaving()
    {
        Conversation conversation = CreateConversation(factory.CurrentUserId);
        conversation.BindAgentSession(factory.AgentClient.Result.SessionId, DateTime.UtcNow);
        factory.Conversation = conversation;
        factory.FileAsset = null;
        factory.ConversationRepository.Reset();
        factory.AgentClient.Reset();
        factory.AgentClient.Result = new AgentConversationTurnResult(
            Guid.Parse("22222222-2222-2222-2222-222222222222"),
            "leaf-2",
            "completed",
            "Unexpected session.");

        using HttpResponseMessage response = await PostTurnAsync(
            conversation.Id,
            new { message = "Continue." });

        Assert.Equal(HttpStatusCode.InternalServerError, response.StatusCode);
        Assert.Equal(0, factory.ConversationRepository.SaveChangesCallCount);
        Assert.Equal(
            Guid.Parse("11111111-1111-1111-1111-111111111111"),
            conversation.AgentSessionId);
    }

    [Fact]
    public async Task PostTurn_WhenConversationDoesNotExistReturnsNotFoundWithoutCallingAgent()
    {
        factory.Conversation = null;
        factory.FileAsset = null;
        factory.ConversationRepository.Reset();
        factory.AgentClient.Reset();

        using HttpResponseMessage response = await PostTurnAsync(
            Guid.NewGuid(),
            new { message = "Inspect the workbook." });

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Equal(1, factory.ConversationRepository.GetCallCount);
        Assert.Equal(0, factory.AgentClient.CallCount);
    }

    [Fact]
    public async Task PostTurn_WithBlankMessageDoesNotQueryConversationOrCallAgent()
    {
        factory.Conversation = null;
        factory.FileAsset = null;
        factory.ConversationRepository.Reset();
        factory.FileAssetRepository.Reset();
        factory.AgentClient.Reset();

        using HttpResponseMessage response = await PostTurnAsync(
            Guid.NewGuid(),
            new { message = "  " });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(0, factory.ConversationRepository.GetCallCount);
        Assert.Equal(0, factory.FileAssetRepository.CallCount);
        Assert.Equal(0, factory.AgentClient.CallCount);
    }

    [Fact]
    public async Task PostTurn_WithoutConversationIdRouteReturnsNotFound()
    {
        factory.AgentClient.Reset();

        using HttpResponseMessage response = await httpClient.PostAsJsonAsync(
            "/api/conversations/turns",
            new { message = "Hello." });

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Equal(0, factory.AgentClient.CallCount);
    }

    private async Task<HttpResponseMessage> PostTurnAsync(
        Guid conversationId,
        object requestBody)
    {
        return await httpClient.PostAsJsonAsync(
            $"/api/conversations/{conversationId}/turns",
            requestBody);
    }

    private static Conversation CreateConversation(Guid userId) =>
        Conversation.Create(
            userId,
            Conversation.DefaultTitle,
            new DateTime(2026, 8, 25, 12, 0, 0, DateTimeKind.Utc));

    private static FileAsset CreateFileAsset(Guid userId)
    {
        return FileAsset.Create(
            userId,
            "report.xlsx",
            "stored-report.xlsx",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            1234,
            "uploads/stored-report.xlsx",
            new DateTime(2026, 8, 25, 12, 0, 0, DateTimeKind.Utc));
    }

    private sealed record ConversationResponse(
        Guid ConversationId,
        string? LeafId,
        string Status,
        string Output);
}

public sealed class ConversationTestFactory : WebApplicationFactory<Program>
{
    public static readonly Guid TestUserId =
        Guid.Parse("dddddddd-dddd-dddd-dddd-dddddddddddd");

    public ConversationTestFactory()
    {
        ConversationRepository = new TestConversationRepository(this);
        FileAssetRepository = new TestFileAssetRepository(this);
        AgentClient = new TestAgentConversationClient();
    }

    public Conversation? Conversation { get; set; }

    public FileAsset? FileAsset { get; set; }

    public TestConversationRepository ConversationRepository { get; }

    public TestFileAssetRepository FileAssetRepository { get; }

    public TestAgentConversationClient AgentClient { get; }

    public Guid CurrentUserId => TestUserId;

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Testing");
        builder.UseSetting(
            "ConnectionStrings:Postgres",
            "Host=localhost;Port=5432;Database=unused;Username=unused;Password=unused");
        builder.UseSetting("AgentService:BaseUrl", "http://127.0.0.1:3000");
        builder.UseSetting("Jwt:SigningKey", TestJwtConfiguration.SigningKey);
        builder.ConfigureLogging(logging =>
        {
            logging.ClearProviders();
            logging.AddConsole();
        });
        builder.ConfigureServices(services =>
        {
            services.AddAuthentication(options =>
                {
                    options.DefaultAuthenticateScheme = ConversationTestAuthenticationHandler.TestScheme;
                    options.DefaultChallengeScheme = ConversationTestAuthenticationHandler.TestScheme;
                })
                .AddScheme<AuthenticationSchemeOptions, ConversationTestAuthenticationHandler>(
                    ConversationTestAuthenticationHandler.TestScheme,
                    _ => { });
            services.AddAuthorization(options =>
            {
                options.DefaultPolicy = new AuthorizationPolicyBuilder(
                        ConversationTestAuthenticationHandler.TestScheme)
                    .RequireAuthenticatedUser()
                    .Build();
            });
            services.RemoveAll<ICurrentUser>();
            services.AddSingleton<ICurrentUser>(new TestCurrentUser(TestUserId));
            services.RemoveAll<IConversationRepository>();
            services.AddSingleton<IConversationRepository>(ConversationRepository);
            services.RemoveAll<IFileAssetRepository>();
            services.AddSingleton<IFileAssetRepository>(FileAssetRepository);
            services.RemoveAll<IAgentConversationClient>();
            services.AddSingleton<IAgentConversationClient>(AgentClient);
        });
    }
}

public sealed class TestConversationRepository(ConversationTestFactory factory)
    : IConversationRepository
{
    public int GetCallCount { get; private set; }

    public int SaveChangesCallCount { get; private set; }

    public Guid RequestedConversationId { get; private set; }

    public Guid RequestedUserId { get; private set; }

    public Task<Conversation?> GetByIdAndUserIdAsync(
        Guid conversationId,
        Guid userId,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        GetCallCount++;
        RequestedConversationId = conversationId;
        RequestedUserId = userId;

        return Task.FromResult(
            factory.Conversation?.Id == conversationId &&
                factory.Conversation.UserId == userId
                ? factory.Conversation
                : null);
    }

    public Task AddAsync(
        Conversation conversation,
        CancellationToken cancellationToken)
    {
        throw new NotSupportedException();
    }

    public Task<IReadOnlyList<Conversation>> ListByUserIdAsync(
        Guid userId,
        CancellationToken cancellationToken)
    {
        throw new NotSupportedException();
    }

    public Task SaveChangesAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        SaveChangesCallCount++;
        return Task.CompletedTask;
    }

    public void Reset()
    {
        GetCallCount = 0;
        SaveChangesCallCount = 0;
        RequestedConversationId = Guid.Empty;
        RequestedUserId = Guid.Empty;
    }
}

public sealed class TestFileAssetRepository(ConversationTestFactory factory)
    : IFileAssetRepository
{
    public int CallCount { get; private set; }

    public Guid RequestedUserId { get; private set; }

    public CancellationToken RequestedCancellationToken { get; private set; }

    public Task<FileAsset?> GetByIdAndUserIdAsync(
        Guid fileId,
        Guid userId,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        CallCount++;
        RequestedUserId = userId;
        RequestedCancellationToken = cancellationToken;

        return Task.FromResult(
            factory.FileAsset?.Id == fileId && factory.FileAsset.UserId == userId
                ? factory.FileAsset
                : null);
    }

    public Task AddAsync(FileAsset fileAsset, CancellationToken cancellationToken)
    {
        throw new NotSupportedException();
    }

    public Task SaveChangesAsync(CancellationToken cancellationToken)
    {
        throw new NotSupportedException();
    }

    public void Reset()
    {
        CallCount = 0;
        RequestedUserId = Guid.Empty;
        RequestedCancellationToken = default;
    }
}

public sealed class TestCurrentUser(Guid userId) : ICurrentUser
{
    public Guid UserId { get; } = userId;
}

public sealed class ConversationTestAuthenticationHandler(
    Microsoft.Extensions.Options.IOptionsMonitor<AuthenticationSchemeOptions> options,
    ILoggerFactory logger,
    UrlEncoder encoder)
    : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
{
    public const string TestScheme = "ConversationTest";

    protected override Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        var identity = new ClaimsIdentity(
            [new Claim("sub", ConversationTestFactory.TestUserId.ToString())],
            TestScheme);
        var principal = new ClaimsPrincipal(identity);
        var ticket = new AuthenticationTicket(principal, TestScheme);
        return Task.FromResult(AuthenticateResult.Success(ticket));
    }
}

public sealed class TestAgentConversationClient : IAgentConversationClient
{
    public AgentConversationHistory History { get; set; } = new(null, []);

    public IReadOnlyList<AgentServiceStreamEvent> StreamEvents { get; set; } = [];

    public Guid? RequestedHistorySessionId { get; private set; }

    public int HistoryCallCount { get; private set; }

    public AgentConversationTurnResult Result { get; set; } = new(
        Guid.Parse("11111111-1111-1111-1111-111111111111"),
        "leaf-1",
        "completed",
        "Workbook inspected.");

    public AgentConversationTurnRequest? Request { get; private set; }

    public AgentConversationTurnRequest? StreamRequest { get; private set; }

    public int CallCount { get; private set; }

    public int StreamCallCount { get; private set; }

    public CancellationToken RequestedStreamCancellationToken { get; private set; }

    public Task<AgentConversationHistory> GetHistoryAsync(
        Guid sessionId,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        RequestedHistorySessionId = sessionId;
        HistoryCallCount++;
        return Task.FromResult(History);
    }

    public Task<AgentConversationTurnResult> RunTurnAsync(
        AgentConversationTurnRequest request,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        Request = request;
        CallCount++;
        return Task.FromResult(Result);
    }

    public async IAsyncEnumerable<AgentServiceStreamEvent> StreamTurnAsync(
        AgentConversationTurnRequest request,
        [System.Runtime.CompilerServices.EnumeratorCancellation]
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        StreamRequest = request;
        RequestedStreamCancellationToken = cancellationToken;
        StreamCallCount++;

        foreach (AgentServiceStreamEvent streamEvent in StreamEvents)
        {
            cancellationToken.ThrowIfCancellationRequested();
            yield return streamEvent;
        }
    }

    public void Reset()
    {
        History = new AgentConversationHistory(null, []);
        StreamEvents = [];
        RequestedHistorySessionId = null;
        HistoryCallCount = 0;
        Request = null;
        StreamRequest = null;
        CallCount = 0;
        StreamCallCount = 0;
        RequestedStreamCancellationToken = default;
        Result = new AgentConversationTurnResult(
            Guid.Parse("11111111-1111-1111-1111-111111111111"),
            "leaf-1",
            "completed",
            "Workbook inspected.");
    }
}
