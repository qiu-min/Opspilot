using OpsPilot.Application.Abstractions.AgentService;
using OpsPilot.Application.Abstractions.Persistence;
using OpsPilot.Application.Abstractions.Security;
using OpsPilot.Application.Conversations.RunTurn;
using OpsPilot.Application.Exceptions;
using OpsPilot.Domain.Conversations;
using OpsPilot.Domain.Files;

namespace OpsPilot.UnitTests;

public sealed class RunConversationTurnHandlerTests
{
    private static readonly Guid CurrentUserId =
        Guid.Parse("cccccccc-cccc-cccc-cccc-cccccccccccc");

    private static readonly Guid OtherUserId =
        Guid.Parse("dddddddd-dddd-dddd-dddd-dddddddddddd");

    private static readonly Guid FirstSessionId =
        Guid.Parse("11111111-1111-1111-1111-111111111111");

    private static readonly Guid SecondSessionId =
        Guid.Parse("22222222-2222-2222-2222-222222222222");

    private static readonly DateTime CreatedAtUtc =
        new(2026, 8, 25, 12, 0, 0, DateTimeKind.Utc);

    private static readonly DateTime TurnCompletedAtUtc =
        CreatedAtUtc.AddMinutes(1);

    [Fact]
    public async Task HandleAsync_WhenConversationDoesNotExistDoesNotCallAgentService()
    {
        var conversationRepository = new FakeConversationRepository();
        var agentClient = new FakeAgentConversationClient();
        RunConversationTurnHandler handler = CreateHandler(
            conversationRepository,
            new FakeFileAssetRepository(null),
            agentClient);

        await Assert.ThrowsAsync<ApplicationNotFoundException>(() => handler.HandleAsync(
            new RunConversationTurnCommand(Guid.NewGuid(), null, "Inspect the workbook."),
            CancellationToken.None));

        Assert.Equal(1, conversationRepository.GetCallCount);
        Assert.Equal(0, conversationRepository.SaveChangesCallCount);
        Assert.Equal(0, agentClient.CallCount);
    }

    [Fact]
    public async Task HandleAsync_WhenConversationBelongsToAnotherUserReturnsNotFound()
    {
        var conversationRepository = new FakeConversationRepository
        {
            Conversation = CreateConversation(OtherUserId),
        };
        var agentClient = new FakeAgentConversationClient();
        RunConversationTurnHandler handler = CreateHandler(
            conversationRepository,
            new FakeFileAssetRepository(null),
            agentClient);

        await Assert.ThrowsAsync<ApplicationNotFoundException>(() => handler.HandleAsync(
            new RunConversationTurnCommand(
                conversationRepository.Conversation!.Id,
                null,
                "Inspect the workbook."),
            CancellationToken.None));

        Assert.Equal(CurrentUserId, conversationRepository.RequestedUserId);
        Assert.Equal(0, agentClient.CallCount);
    }

    [Fact]
    public async Task HandleAsync_FirstTurnSendsNullSessionBindsReturnedSessionAndSaves()
    {
        Conversation conversation = CreateConversation(CurrentUserId);
        var conversationRepository = new FakeConversationRepository
        {
            Conversation = conversation,
        };
        var agentClient = new FakeAgentConversationClient
        {
            Result = new AgentConversationTurnResult(
                FirstSessionId,
                "leaf-1",
                "completed",
                "Workbook inspected."),
        };
        using var cancellationSource = new CancellationTokenSource();
        RunConversationTurnHandler handler = CreateHandler(
            conversationRepository,
            new FakeFileAssetRepository(null),
            agentClient);

        RunConversationTurnResult result = await handler.HandleAsync(
            new RunConversationTurnCommand(
                conversation.Id,
                null,
                "Inspect the workbook."),
            cancellationSource.Token);

        Assert.Equal(conversation.Id, result.ConversationId);
        Assert.Equal("leaf-1", result.LeafId);
        Assert.Equal("completed", result.Status);
        Assert.Equal("Workbook inspected.", result.Output);
        Assert.Equal(
            new AgentConversationTurnRequest(
                null,
                "Inspect the workbook.",
                null),
            agentClient.Request);
        Assert.Equal(FirstSessionId, conversation.AgentSessionId);
        Assert.Equal(TurnCompletedAtUtc, conversation.UpdatedAtUtc);
        Assert.Equal(1, conversationRepository.SaveChangesCallCount);
        Assert.Equal(cancellationSource.Token, conversationRepository.RequestedSaveChangesToken);
        Assert.Equal(cancellationSource.Token, agentClient.RequestedCancellationToken);
    }

    [Fact]
    public async Task HandleAsync_SubsequentTurnReusesSessionAndRefreshesTimestamp()
    {
        Conversation conversation = CreateConversation(CurrentUserId);
        DateTime firstTurnAtUtc = CreatedAtUtc.AddMinutes(1);
        conversation.BindAgentSession(FirstSessionId, firstTurnAtUtc);
        var conversationRepository = new FakeConversationRepository
        {
            Conversation = conversation,
        };
        var agentClient = new FakeAgentConversationClient
        {
            Result = new AgentConversationTurnResult(
                FirstSessionId,
                "leaf-2",
                "completed",
                "Workbook inspected again."),
        };
        RunConversationTurnHandler handler = CreateHandler(
            conversationRepository,
            new FakeFileAssetRepository(null),
            agentClient);

        await handler.HandleAsync(
            new RunConversationTurnCommand(
                conversation.Id,
                null,
                "Inspect it again."),
            CancellationToken.None);

        Assert.Equal(
            new AgentConversationTurnRequest(
                FirstSessionId,
                "Inspect it again.",
                null),
            agentClient.Request);
        Assert.Equal(FirstSessionId, conversation.AgentSessionId);
        Assert.Equal(TurnCompletedAtUtc, conversation.UpdatedAtUtc);
        Assert.Equal(1, conversationRepository.SaveChangesCallCount);
    }

    [Fact]
    public async Task HandleAsync_WhenAgentReturnsDifferentSessionRejectsWithoutSaving()
    {
        Conversation conversation = CreateConversation(CurrentUserId);
        DateTime originalUpdatedAtUtc = CreatedAtUtc.AddMinutes(1);
        conversation.BindAgentSession(FirstSessionId, originalUpdatedAtUtc);
        var conversationRepository = new FakeConversationRepository
        {
            Conversation = conversation,
        };
        var agentClient = new FakeAgentConversationClient
        {
            Result = new AgentConversationTurnResult(
                SecondSessionId,
                "leaf-2",
                "completed",
                "Workbook inspected again."),
        };
        RunConversationTurnHandler handler = CreateHandler(
            conversationRepository,
            new FakeFileAssetRepository(null),
            agentClient);

        await Assert.ThrowsAsync<InvalidOperationException>(() => handler.HandleAsync(
            new RunConversationTurnCommand(
                conversation.Id,
                null,
                "Inspect it again."),
            CancellationToken.None));

        Assert.Equal(FirstSessionId, conversation.AgentSessionId);
        Assert.Equal(originalUpdatedAtUtc, conversation.UpdatedAtUtc);
        Assert.Equal(0, conversationRepository.SaveChangesCallCount);
    }

    [Fact]
    public async Task HandleAsync_WhenAgentCallFailsDoesNotBindOrSaveConversation()
    {
        Conversation conversation = CreateConversation(CurrentUserId);
        var conversationRepository = new FakeConversationRepository
        {
            Conversation = conversation,
        };
        var agentClient = new FakeAgentConversationClient
        {
            ExceptionToThrow = new InvalidOperationException("agent unavailable"),
        };
        RunConversationTurnHandler handler = CreateHandler(
            conversationRepository,
            new FakeFileAssetRepository(null),
            agentClient);

        await Assert.ThrowsAsync<InvalidOperationException>(() => handler.HandleAsync(
            new RunConversationTurnCommand(
                conversation.Id,
                null,
                "Inspect the workbook."),
            CancellationToken.None));

        Assert.Null(conversation.AgentSessionId);
        Assert.Equal(CreatedAtUtc, conversation.UpdatedAtUtc);
        Assert.Equal(0, conversationRepository.SaveChangesCallCount);
    }

    [Fact]
    public async Task HandleAsync_WithFileIdForwardsOwnedFileResourceToAgent()
    {
        Conversation conversation = CreateConversation(CurrentUserId);
        FileAsset fileAsset = CreateFileAsset(CurrentUserId);
        var fileAssetRepository = new FakeFileAssetRepository(fileAsset);
        var conversationRepository = new FakeConversationRepository
        {
            Conversation = conversation,
        };
        var agentClient = new FakeAgentConversationClient();
        RunConversationTurnHandler handler = CreateHandler(
            conversationRepository,
            fileAssetRepository,
            agentClient);
        using var cancellationSource = new CancellationTokenSource();

        await handler.HandleAsync(
            new RunConversationTurnCommand(
                conversation.Id,
                fileAsset.Id,
                "Which sheets are in this workbook?"),
            cancellationSource.Token);

        Assert.Equal(
            new AgentConversationTurnRequest(
                null,
                "Which sheets are in this workbook?",
                new AgentExcelResource(fileAsset.Id, fileAsset.StoragePath)),
            agentClient.Request);
        Assert.Equal(CurrentUserId, fileAssetRepository.RequestedUserId);
        Assert.Equal(cancellationSource.Token, fileAssetRepository.RequestedCancellationToken);
    }

    [Fact]
    public async Task HandleAsync_WithBlankMessageDoesNotQueryOrCallExternalServices()
    {
        var conversationRepository = new FakeConversationRepository();
        var fileAssetRepository = new FakeFileAssetRepository(null);
        var agentClient = new FakeAgentConversationClient();
        RunConversationTurnHandler handler = CreateHandler(
            conversationRepository,
            fileAssetRepository,
            agentClient);

        await Assert.ThrowsAsync<ApplicationValidationException>(() => handler.HandleAsync(
            new RunConversationTurnCommand(Guid.NewGuid(), null, "  "),
            CancellationToken.None));

        Assert.Equal(0, conversationRepository.GetCallCount);
        Assert.Equal(0, fileAssetRepository.CallCount);
        Assert.Equal(0, agentClient.CallCount);
    }

    private static RunConversationTurnHandler CreateHandler(
        FakeConversationRepository conversationRepository,
        FakeFileAssetRepository fileAssetRepository,
        FakeAgentConversationClient agentClient)
    {
        var getFileAssetHandler = new OpsPilot.Application.Files.GetById.GetFileAssetHandler(
            fileAssetRepository,
            new FakeCurrentUser(CurrentUserId));

        return new RunConversationTurnHandler(
            getFileAssetHandler,
            conversationRepository,
            new FakeCurrentUser(CurrentUserId),
            new FixedTimeProvider(new DateTimeOffset(TurnCompletedAtUtc)),
            agentClient);
    }

    private static Conversation CreateConversation(Guid userId) =>
        Conversation.Create(userId, Conversation.DefaultTitle, CreatedAtUtc);

    private static FileAsset CreateFileAsset(Guid userId)
    {
        return FileAsset.Create(
            userId,
            "report.xlsx",
            "stored-report.xlsx",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            1234,
            "uploads/stored-report.xlsx",
            CreatedAtUtc);
    }

    private sealed class FixedTimeProvider(DateTimeOffset currentTime) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => currentTime;
    }

    private sealed class FakeCurrentUser(Guid userId) : ICurrentUser
    {
        public Guid UserId { get; } = userId;
    }

    private sealed class FakeConversationRepository : IConversationRepository
    {
        public Conversation? Conversation { get; init; }

        public int GetCallCount { get; private set; }

        public int SaveChangesCallCount { get; private set; }

        public Guid RequestedConversationId { get; private set; }

        public Guid RequestedUserId { get; private set; }

        public CancellationToken RequestedSaveChangesToken { get; private set; }

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
                Conversation?.Id == conversationId && Conversation.UserId == userId
                    ? Conversation
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
            RequestedSaveChangesToken = cancellationToken;
            SaveChangesCallCount++;
            return Task.CompletedTask;
        }
    }

    private sealed class FakeFileAssetRepository(FileAsset? fileAsset) : IFileAssetRepository
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
                fileAsset?.Id == fileId && fileAsset.UserId == userId
                    ? fileAsset
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
    }

    private sealed class FakeAgentConversationClient : IAgentConversationClient
    {
        public AgentConversationTurnResult Result { get; init; } =
            new(FirstSessionId, "leaf-1", "completed", "Workbook inspected.");

        public Exception? ExceptionToThrow { get; init; }

        public AgentConversationTurnRequest? Request { get; private set; }

        public CancellationToken RequestedCancellationToken { get; private set; }

        public int CallCount { get; private set; }

        public Task<AgentConversationTurnResult> RunTurnAsync(
            AgentConversationTurnRequest request,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            Request = request;
            RequestedCancellationToken = cancellationToken;
            CallCount++;

            if (ExceptionToThrow is not null)
            {
                throw ExceptionToThrow;
            }

            return Task.FromResult(Result);
        }
    }
}
