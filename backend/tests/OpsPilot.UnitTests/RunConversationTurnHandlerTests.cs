using OpsPilot.Application.Abstractions.AgentService;
using OpsPilot.Application.Abstractions.Persistence;
using OpsPilot.Application.Conversations.RunTurn;
using OpsPilot.Application.Exceptions;
using OpsPilot.Domain.Files;

namespace OpsPilot.UnitTests;

public sealed class RunConversationTurnHandlerTests
{
    [Fact]
    public async Task HandleAsync_WithFileIdLoadsAssetAndForwardsStorageResource()
    {
        Guid sessionId = Guid.NewGuid();
        FileAsset fileAsset = CreateFileAsset();
        var repository = new FakeFileAssetRepository(fileAsset);
        var getFileAssetHandler = new OpsPilot.Application.Files.GetById.GetFileAssetHandler(
            repository);
        var agentClient = new FakeAgentConversationClient();
        var handler = new RunConversationTurnHandler(getFileAssetHandler, agentClient);
        using var cancellationSource = new CancellationTokenSource();

        RunConversationTurnResult? result = await handler.HandleAsync(
            new RunConversationTurnCommand(sessionId, fileAsset.Id, "Inspect the workbook."),
            cancellationSource.Token);

        Assert.NotNull(result);
        Assert.Equal(agentClient.Result.SessionId, result!.SessionId);
        Assert.Equal(agentClient.Result.LeafId, result.LeafId);
        Assert.Equal(agentClient.Result.Status, result.Status);
        Assert.Equal(agentClient.Result.Output, result.Output);
        Assert.Equal(
            new AgentConversationTurnRequest(
                sessionId,
                "Inspect the workbook.",
                new AgentExcelResource(fileAsset.Id, fileAsset.StoragePath)),
            agentClient.Request);
        Assert.Equal(cancellationSource.Token, repository.RequestedCancellationToken);
        Assert.Equal(cancellationSource.Token, agentClient.RequestedCancellationToken);
    }

    [Fact]
    public async Task HandleAsync_WithoutFileIdSendsConversationWithoutResource()
    {
        var repository = new FakeFileAssetRepository(null);
        var agentClient = new FakeAgentConversationClient();
        var handler = new RunConversationTurnHandler(
            new OpsPilot.Application.Files.GetById.GetFileAssetHandler(repository),
            agentClient);

        RunConversationTurnResult? result = await handler.HandleAsync(
            new RunConversationTurnCommand(null, null, "Hello."),
            CancellationToken.None);

        Assert.NotNull(result);
        Assert.Equal(new AgentConversationTurnRequest(null, "Hello.", null), agentClient.Request);
        Assert.Equal(0, repository.CallCount);
    }

    [Fact]
    public async Task HandleAsync_WhenFileAssetDoesNotExistDoesNotCallAgentService()
    {
        var repository = new FakeFileAssetRepository(null);
        var agentClient = new FakeAgentConversationClient();
        var handler = new RunConversationTurnHandler(
            new OpsPilot.Application.Files.GetById.GetFileAssetHandler(repository),
            agentClient);

        RunConversationTurnResult? result = await handler.HandleAsync(
            new RunConversationTurnCommand(null, Guid.NewGuid(), "Inspect the workbook."),
            CancellationToken.None);

        Assert.Null(result);
        Assert.Equal(0, agentClient.CallCount);
    }

    [Fact]
    public async Task HandleAsync_WithBlankMessageThrowsValidationException()
    {
        var agentClient = new FakeAgentConversationClient();
        var handler = new RunConversationTurnHandler(
            new OpsPilot.Application.Files.GetById.GetFileAssetHandler(
                new FakeFileAssetRepository(null)),
            agentClient);

        await Assert.ThrowsAsync<ApplicationValidationException>(() =>
            handler.HandleAsync(
                new RunConversationTurnCommand(null, null, "  "),
                CancellationToken.None));

        Assert.Equal(0, agentClient.CallCount);
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

    private sealed class FakeAgentConversationClient : IAgentConversationClient
    {
        public AgentConversationTurnResult Result { get; } = new(
            Guid.NewGuid(),
            "leaf-1",
            "completed",
            "Workbook inspected.");

        public AgentConversationTurnRequest? Request { get; private set; }

        public CancellationToken RequestedCancellationToken { get; private set; }

        public int CallCount { get; private set; }

        public Task<AgentConversationTurnResult> RunTurnAsync(
            AgentConversationTurnRequest request,
            CancellationToken cancellationToken)
        {
            Request = request;
            RequestedCancellationToken = cancellationToken;
            CallCount++;
            return Task.FromResult(Result);
        }
    }

    private sealed class FakeFileAssetRepository(FileAsset? fileAsset) : IFileAssetRepository
    {
        public int CallCount { get; private set; }

        public CancellationToken RequestedCancellationToken { get; private set; }

        public Task<FileAsset?> GetByIdAsync(
            Guid fileId,
            CancellationToken cancellationToken)
        {
            CallCount++;
            RequestedCancellationToken = cancellationToken;
            return Task.FromResult(fileAsset);
        }

        public Task AddAsync(FileAsset fileAsset, CancellationToken cancellationToken)
        {
            throw new NotSupportedException();
        }

        public Task SaveChangesAsync(CancellationToken cancellationToken)
        {
            throw new NotSupportedException();
        }
    }
}
