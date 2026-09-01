using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using OpsPilot.Application.Abstractions.AgentService;
using OpsPilot.Application.Abstractions.Persistence;
using OpsPilot.Domain.Files;

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
        FileAsset fileAsset = CreateFileAsset();
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

    private static FileAsset CreateFileAsset()
    {
        return FileAsset.Create(
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
    public ConversationTestFactory()
    {
        FileAssetRepository = new TestFileAssetRepository(this);
        AgentClient = new TestAgentConversationClient();
    }

    public FileAsset? FileAsset { get; set; }

    public TestFileAssetRepository FileAssetRepository { get; }

    public TestAgentConversationClient AgentClient { get; }

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.ConfigureServices(services =>
        {
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

    public Task<FileAsset?> GetByIdAsync(Guid fileId, CancellationToken cancellationToken)
    {
        CallCount++;
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult(factory.FileAsset?.Id == fileId ? factory.FileAsset : null);
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
