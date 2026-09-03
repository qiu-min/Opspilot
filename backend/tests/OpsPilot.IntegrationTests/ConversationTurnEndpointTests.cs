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
    public async Task PostTurn_WithFileIdForwardsFileResourceAndReturnsAgentResult()
    {
        FileAsset fileAsset = CreateFileAsset(factory.CurrentUserId);
        factory.FileAsset = fileAsset;
        factory.FileAssetRepository.Reset();
        factory.AgentClient.Reset();
        Guid sessionId = Guid.NewGuid();

        using HttpResponseMessage response = await httpClient.PostAsJsonAsync(
            "/api/conversations/turns",
            new
            {
                sessionId,
                fileId = fileAsset.Id,
                message = "Which sheets are in this workbook?",
            });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        ConversationResponse? body = await response.Content.ReadFromJsonAsync<ConversationResponse>();
        Assert.NotNull(body);
        Assert.Equal(factory.AgentClient.Result.SessionId, body!.SessionId);
        Assert.Equal(factory.AgentClient.Result.LeafId, body.LeafId);
        Assert.Equal(factory.AgentClient.Result.Status, body.Status);
        Assert.Equal(factory.AgentClient.Result.Output, body.Output);
        Assert.Equal(
            new AgentConversationTurnRequest(
                sessionId,
                "Which sheets are in this workbook?",
                new AgentExcelResource(fileAsset.Id, fileAsset.StoragePath)),
            factory.AgentClient.Request);
    }

    [Fact]
    public async Task PostTurn_WithoutFileIdDoesNotQueryFileAssets()
    {
        factory.FileAsset = null;
        factory.FileAssetRepository.Reset();
        factory.AgentClient.Reset();

        using HttpResponseMessage response = await httpClient.PostAsJsonAsync(
            "/api/conversations/turns",
            new { message = "Hello." });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(0, factory.FileAssetRepository.CallCount);
        Assert.Equal(new AgentConversationTurnRequest(null, "Hello.", null), factory.AgentClient.Request);
    }

    [Fact]
    public async Task PostTurn_WhenFileDoesNotExistReturnsNotFoundWithoutCallingAgentService()
    {
        factory.FileAsset = null;
        factory.FileAssetRepository.Reset();
        factory.AgentClient.Reset();

        using HttpResponseMessage response = await httpClient.PostAsJsonAsync(
            "/api/conversations/turns",
            new { fileId = Guid.NewGuid(), message = "Inspect the workbook." });

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Null(factory.AgentClient.Request);
        Assert.Equal(0, factory.AgentClient.CallCount);
    }

    [Fact]
    public async Task PostTurn_WithBlankMessageReturnsBadRequest()
    {
        factory.FileAsset = null;
        factory.FileAssetRepository.Reset();
        factory.AgentClient.Reset();

        using HttpResponseMessage response = await httpClient.PostAsJsonAsync(
            "/api/conversations/turns",
            new { message = "  " });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(0, factory.AgentClient.CallCount);
    }

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
        Guid SessionId,
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
        FileAssetRepository = new TestFileAssetRepository(this);
        AgentClient = new TestAgentConversationClient();
    }

    public FileAsset? FileAsset { get; set; }

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
            services.RemoveAll<IFileAssetRepository>();
            services.AddSingleton<IFileAssetRepository>(FileAssetRepository);
            services.RemoveAll<IAgentConversationClient>();
            services.AddSingleton<IAgentConversationClient>(AgentClient);
        });
    }
}

public sealed class TestFileAssetRepository(ConversationTestFactory factory) : IFileAssetRepository
{
    public int CallCount { get; private set; }

    public Task<FileAsset?> GetByIdAndUserIdAsync(
        Guid fileId,
        Guid userId,
        CancellationToken cancellationToken)
    {
        CallCount++;
        cancellationToken.ThrowIfCancellationRequested();
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
    public AgentConversationTurnResult Result { get; } = new(
        Guid.Parse("11111111-1111-1111-1111-111111111111"),
        "leaf-1",
        "completed",
        "Workbook inspected.");

    public AgentConversationTurnRequest? Request { get; private set; }

    public int CallCount { get; private set; }

    public Task<AgentConversationTurnResult> RunTurnAsync(
        AgentConversationTurnRequest request,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        Request = request;
        CallCount++;
        return Task.FromResult(Result);
    }

    public void Reset()
    {
        Request = null;
        CallCount = 0;
    }
}
