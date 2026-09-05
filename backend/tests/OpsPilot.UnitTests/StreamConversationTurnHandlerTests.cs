using System.Runtime.CompilerServices;
using OpsPilot.Application.Abstractions.AgentService;
using OpsPilot.Application.Abstractions.Persistence;
using OpsPilot.Application.Abstractions.Security;
using OpsPilot.Application.Conversations.StreamTurn;
using OpsPilot.Application.Exceptions;
using OpsPilot.Domain.Conversations;
using OpsPilot.Domain.Files;

namespace OpsPilot.UnitTests;

public sealed class StreamConversationTurnHandlerTests
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

    private static readonly DateTime StreamUpdatedAtUtc =
        CreatedAtUtc.AddMinutes(1);

    [Fact]
    public async Task HandleAsync_WhenMessageIsBlankValidatesBeforeExternalCalls()
    {
        var repository = new FakeConversationRepository();
        var fileRepository = new FakeFileAssetRepository(null);
        var agentClient = new FakeAgentConversationClient();
        StreamConversationTurnHandler handler = CreateHandler(
            repository,
            fileRepository,
            agentClient);

        await Assert.ThrowsAsync<ApplicationValidationException>(() => CollectAsync(
            handler,
            new StreamConversationTurnCommand(Guid.NewGuid(), null, " "),
            CancellationToken.None));

        Assert.Equal(0, repository.GetCallCount);
        Assert.Equal(0, fileRepository.CallCount);
        Assert.Equal(0, agentClient.StreamCallCount);
    }

    [Fact]
    public async Task HandleAsync_WhenConversationIsNotOwnedReturnsNotFound()
    {
        Conversation conversation = CreateConversation(OtherUserId);
        var repository = new FakeConversationRepository { Conversation = conversation };
        var agentClient = new FakeAgentConversationClient();
        StreamConversationTurnHandler handler = CreateHandler(
            repository,
            new FakeFileAssetRepository(null),
            agentClient);

        await Assert.ThrowsAsync<ApplicationNotFoundException>(() => CollectAsync(
            handler,
            new StreamConversationTurnCommand(conversation.Id, null, "Hello."),
            CancellationToken.None));

        Assert.Equal(CurrentUserId, repository.RequestedUserId);
        Assert.Equal(0, agentClient.StreamCallCount);
    }

    [Fact]
    public async Task HandleAsync_WithFileIdResolvesOwnedFileAndReusesExistingSession()
    {
        Conversation conversation = CreateConversation(CurrentUserId);
        conversation.BindAgentSession(FirstSessionId, CreatedAtUtc);
        FileAsset fileAsset = CreateFileAsset(CurrentUserId);
        var repository = new FakeConversationRepository { Conversation = conversation };
        var fileRepository = new FakeFileAssetRepository(fileAsset);
        var agentClient = new FakeAgentConversationClient
        {
            Events =
            [
                new AgentServiceStreamEvent.Done(FirstSessionId, "leaf-1", "completed"),
            ],
        };
        StreamConversationTurnHandler handler = CreateHandler(
            repository,
            fileRepository,
            agentClient);

        List<ConversationStreamEvent> events = await CollectAsync(
            handler,
            new StreamConversationTurnCommand(
                conversation.Id,
                fileAsset.Id,
                "Which sheets are in this workbook?"),
            CancellationToken.None);

        Assert.Equal(
            new AgentConversationTurnRequest(
                FirstSessionId,
                "Which sheets are in this workbook?",
                new AgentExcelResource(fileAsset.Id, fileAsset.StoragePath)),
            agentClient.Request);
        Assert.Equal(CurrentUserId, fileRepository.RequestedUserId);
        Assert.Collection(
            events,
            item => Assert.IsType<ConversationStreamEvent.ResponseStarted>(item),
            item => Assert.Equal(new ConversationStreamEvent.ResponseCompleted(
                conversation.Id,
                "leaf-1",
                "completed"), item));
    }

    [Fact]
    public async Task HandleAsync_EmitsResponseStartedOnceBeforeAgentEvents()
    {
        Conversation conversation = CreateConversation(CurrentUserId);
        var repository = new FakeConversationRepository { Conversation = conversation };
        var agentClient = new FakeAgentConversationClient
        {
            Events =
            [
                new AgentServiceStreamEvent.SessionReady(FirstSessionId, true),
                new AgentServiceStreamEvent.AgentStarted(),
                new AgentServiceStreamEvent.Done(FirstSessionId, null, "completed"),
            ],
        };
        StreamConversationTurnHandler handler = CreateHandler(
            repository,
            new FakeFileAssetRepository(null),
            agentClient);

        List<ConversationStreamEvent> events = await CollectAsync(
            handler,
            new StreamConversationTurnCommand(conversation.Id, null, "Hello."),
            CancellationToken.None);

        Assert.Equal(
            1,
            events.Count(item => item is ConversationStreamEvent.ResponseStarted));
        Assert.IsType<ConversationStreamEvent.ResponseStarted>(events[0]);
    }

    [Fact]
    public async Task HandleAsync_SessionReadyBindsAndSavesBeforeReadingNextAgentEvent()
    {
        Conversation conversation = CreateConversation(CurrentUserId);
        var repository = new FakeConversationRepository { Conversation = conversation };
        var agentClient = new FakeAgentConversationClient
        {
            Events =
            [
                new AgentServiceStreamEvent.SessionReady(FirstSessionId, false),
                new AgentServiceStreamEvent.AgentStarted(),
                new AgentServiceStreamEvent.Done(FirstSessionId, "leaf-1", "completed"),
            ],
        };
        agentClient.BeforeYield = index =>
        {
            if (index == 1)
            {
                Assert.Equal(FirstSessionId, conversation.AgentSessionId);
                Assert.Equal(1, repository.SaveChangesCallCount);
            }
        };
        StreamConversationTurnHandler handler = CreateHandler(
            repository,
            new FakeFileAssetRepository(null),
            agentClient);

        List<ConversationStreamEvent> events = await CollectAsync(
            handler,
            new StreamConversationTurnCommand(conversation.Id, null, "Hello."),
            CancellationToken.None);

        Assert.Equal(FirstSessionId, conversation.AgentSessionId);
        Assert.Equal(StreamUpdatedAtUtc, conversation.UpdatedAtUtc);
        Assert.Equal(2, repository.SaveChangesCallCount);
    }

    [Fact]
    public async Task HandleAsync_ExistingSessionReadyDoesNotPerformEarlySave()
    {
        Conversation conversation = CreateConversation(CurrentUserId);
        conversation.BindAgentSession(FirstSessionId, CreatedAtUtc);
        var repository = new FakeConversationRepository { Conversation = conversation };
        var agentClient = new FakeAgentConversationClient
        {
            Events =
            [
                new AgentServiceStreamEvent.SessionReady(FirstSessionId, true),
                new AgentServiceStreamEvent.Done(FirstSessionId, null, "completed"),
            ],
        };
        agentClient.BeforeYield = index =>
        {
            if (index == 1) Assert.Equal(0, repository.SaveChangesCallCount);
        };
        StreamConversationTurnHandler handler = CreateHandler(
            repository,
            new FakeFileAssetRepository(null),
            agentClient);

        await CollectAsync(
            handler,
            new StreamConversationTurnCommand(conversation.Id, null, "Hello."),
            CancellationToken.None);

        Assert.Equal(1, repository.SaveChangesCallCount);
    }

    [Fact]
    public async Task HandleAsync_SessionReadyMismatchFailsWithoutOverwritingSession()
    {
        Conversation conversation = CreateConversation(CurrentUserId);
        conversation.BindAgentSession(FirstSessionId, CreatedAtUtc);
        var repository = new FakeConversationRepository { Conversation = conversation };
        var agentClient = new FakeAgentConversationClient
        {
            Events = [new AgentServiceStreamEvent.SessionReady(SecondSessionId, true)],
        };
        StreamConversationTurnHandler handler = CreateHandler(
            repository,
            new FakeFileAssetRepository(null),
            agentClient);

        await Assert.ThrowsAsync<InvalidOperationException>(() => CollectAsync(
            handler,
            new StreamConversationTurnCommand(conversation.Id, null, "Hello."),
            CancellationToken.None));

        Assert.Equal(FirstSessionId, conversation.AgentSessionId);
        Assert.Equal(0, repository.SaveChangesCallCount);
    }

    [Fact]
    public async Task HandleAsync_DoneMismatchFailsWithoutSaving()
    {
        Conversation conversation = CreateConversation(CurrentUserId);
        conversation.BindAgentSession(FirstSessionId, CreatedAtUtc);
        var repository = new FakeConversationRepository { Conversation = conversation };
        var agentClient = new FakeAgentConversationClient
        {
            Events = [new AgentServiceStreamEvent.Done(SecondSessionId, "leaf-1", "completed")],
        };
        StreamConversationTurnHandler handler = CreateHandler(
            repository,
            new FakeFileAssetRepository(null),
            agentClient);

        await Assert.ThrowsAsync<InvalidOperationException>(() => CollectAsync(
            handler,
            new StreamConversationTurnCommand(conversation.Id, null, "Hello."),
            CancellationToken.None));

        Assert.Equal(FirstSessionId, conversation.AgentSessionId);
        Assert.Equal(CreatedAtUtc, conversation.UpdatedAtUtc);
        Assert.Equal(0, repository.SaveChangesCallCount);
    }

    [Fact]
    public async Task HandleAsync_DoneUpdatesConversationAndEmitsResponseCompleted()
    {
        Conversation conversation = CreateConversation(CurrentUserId);
        var repository = new FakeConversationRepository { Conversation = conversation };
        var agentClient = new FakeAgentConversationClient
        {
            Events =
            [
                new AgentServiceStreamEvent.SessionReady(FirstSessionId, true),
                new AgentServiceStreamEvent.Done(FirstSessionId, "leaf-1", "completed"),
            ],
        };
        StreamConversationTurnHandler handler = CreateHandler(
            repository,
            new FakeFileAssetRepository(null),
            agentClient);

        List<ConversationStreamEvent> events = await CollectAsync(
            handler,
            new StreamConversationTurnCommand(conversation.Id, null, "Hello."),
            CancellationToken.None);

        Assert.Equal(FirstSessionId, conversation.AgentSessionId);
        Assert.Equal(StreamUpdatedAtUtc, conversation.UpdatedAtUtc);
        Assert.Equal(2, repository.SaveChangesCallCount);
        Assert.Equal(new ConversationStreamEvent.ResponseCompleted(
            conversation.Id,
            "leaf-1",
            "completed"), events[^1]);
    }

    [Fact]
    public async Task HandleAsync_DoneWithErrorStatusStillEmitsResponseCompleted()
    {
        Conversation conversation = CreateConversation(CurrentUserId);
        var repository = new FakeConversationRepository { Conversation = conversation };
        var agentClient = new FakeAgentConversationClient
        {
            Events =
            [
                new AgentServiceStreamEvent.SessionReady(FirstSessionId, true),
                new AgentServiceStreamEvent.Done(FirstSessionId, null, "error"),
            ],
        };
        StreamConversationTurnHandler handler = CreateHandler(
            repository,
            new FakeFileAssetRepository(null),
            agentClient);

        List<ConversationStreamEvent> events = await CollectAsync(
            handler,
            new StreamConversationTurnCommand(conversation.Id, null, "Hello."),
            CancellationToken.None);

        Assert.Equal(new ConversationStreamEvent.ResponseCompleted(
            conversation.Id,
            null,
            "error"), events[^1]);
        Assert.DoesNotContain(events, item => item is ConversationStreamEvent.Error);
    }

    [Fact]
    public async Task HandleAsync_ErrorIsTerminalAndDoesNotRollbackSessionReady()
    {
        Conversation conversation = CreateConversation(CurrentUserId);
        var repository = new FakeConversationRepository { Conversation = conversation };
        var agentClient = new FakeAgentConversationClient
        {
            Events =
            [
                new AgentServiceStreamEvent.SessionReady(FirstSessionId, true),
                new AgentServiceStreamEvent.Error("transport failed"),
                new AgentServiceStreamEvent.Done(FirstSessionId, "ignored", "completed"),
            ],
        };
        StreamConversationTurnHandler handler = CreateHandler(
            repository,
            new FakeFileAssetRepository(null),
            agentClient);

        List<ConversationStreamEvent> events = await CollectAsync(
            handler,
            new StreamConversationTurnCommand(conversation.Id, null, "Hello."),
            CancellationToken.None);

        Assert.Equal(FirstSessionId, conversation.AgentSessionId);
        Assert.Equal(1, repository.SaveChangesCallCount);
        Assert.Equal(2, events.Count);
        Assert.Equal(new ConversationStreamEvent.Error("transport failed"), events[1]);
    }

    [Fact]
    public async Task HandleAsync_AssistantTextUsesLazyMessageLifecycleAndPreservesWhitespace()
    {
        Conversation conversation = CreateConversation(CurrentUserId);
        var repository = new FakeConversationRepository { Conversation = conversation };
        var agentClient = new FakeAgentConversationClient
        {
            Events =
            [
                new AgentServiceStreamEvent.MessageStarted("assistant"),
                new AgentServiceStreamEvent.TextDelta(0, "hello"),
                new AgentServiceStreamEvent.TextDelta(0, " "),
                new AgentServiceStreamEvent.MessageCompleted("assistant"),
            ],
        };
        StreamConversationTurnHandler handler = CreateHandler(
            repository,
            new FakeFileAssetRepository(null),
            agentClient);

        List<ConversationStreamEvent> events = await CollectAsync(
            handler,
            new StreamConversationTurnCommand(conversation.Id, null, "Hello."),
            CancellationToken.None);

        Assert.Collection(
            events,
            item => Assert.IsType<ConversationStreamEvent.ResponseStarted>(item),
            item => Assert.IsType<ConversationStreamEvent.AssistantMessageStarted>(item),
            item => Assert.Equal(new ConversationStreamEvent.AssistantTextDelta("hello"), item),
            item => Assert.Equal(new ConversationStreamEvent.AssistantTextDelta(" "), item),
            item => Assert.IsType<ConversationStreamEvent.AssistantMessageCompleted>(item));
    }

    [Fact]
    public async Task HandleAsync_ToolCallOnlyAssistantDoesNotEmitEmptyMessageLifecycle()
    {
        Conversation conversation = CreateConversation(CurrentUserId);
        var repository = new FakeConversationRepository { Conversation = conversation };
        var agentClient = new FakeAgentConversationClient
        {
            Events =
            [
                new AgentServiceStreamEvent.MessageStarted("assistant"),
                new AgentServiceStreamEvent.ToolCallDelta(0, "call-1", "{"),
                new AgentServiceStreamEvent.ToolCallCompleted(
                    0,
                    new AgentServiceToolCall("call-1", "lookup", "{}")),
                new AgentServiceStreamEvent.MessageCompleted("assistant"),
                new AgentServiceStreamEvent.SessionReady(FirstSessionId, true),
                new AgentServiceStreamEvent.Done(FirstSessionId, null, "completed"),
            ],
        };
        StreamConversationTurnHandler handler = CreateHandler(
            repository,
            new FakeFileAssetRepository(null),
            agentClient);

        List<ConversationStreamEvent> events = await CollectAsync(
            handler,
            new StreamConversationTurnCommand(conversation.Id, null, "Hello."),
            CancellationToken.None);

        Assert.DoesNotContain(events, item => item is ConversationStreamEvent.AssistantMessageStarted);
        Assert.DoesNotContain(events, item => item is ConversationStreamEvent.AssistantMessageCompleted);
        Assert.IsType<ConversationStreamEvent.ResponseCompleted>(events[^1]);
    }

    [Fact]
    public async Task HandleAsync_ThinkingBeforeTextMapsThinkingLifecycleThenAssistantText()
    {
        Conversation conversation = CreateConversation(CurrentUserId);
        var repository = new FakeConversationRepository { Conversation = conversation };
        var agentClient = new FakeAgentConversationClient
        {
            Events =
            [
                new AgentServiceStreamEvent.MessageStarted("assistant"),
                new AgentServiceStreamEvent.ThinkingDelta(0, "private"),
                new AgentServiceStreamEvent.TextDelta(0, "answer"),
                new AgentServiceStreamEvent.MessageCompleted("assistant"),
            ],
        };
        StreamConversationTurnHandler handler = CreateHandler(
            repository,
            new FakeFileAssetRepository(null),
            agentClient);

        List<ConversationStreamEvent> events = await CollectAsync(
            handler,
            new StreamConversationTurnCommand(conversation.Id, null, "Hello."),
            CancellationToken.None);

        Assert.Collection(
            events,
            item => Assert.IsType<ConversationStreamEvent.ResponseStarted>(item),
            item => Assert.IsType<ConversationStreamEvent.AssistantThinkingStarted>(item),
            item => Assert.IsType<ConversationStreamEvent.AssistantThinkingCompleted>(item),
            item => Assert.IsType<ConversationStreamEvent.AssistantMessageStarted>(item),
            item => Assert.Equal(new ConversationStreamEvent.AssistantTextDelta("answer"), item),
            item => Assert.IsType<ConversationStreamEvent.AssistantMessageCompleted>(item));
    }

    [Fact]
    public async Task HandleAsync_ThinkingOnlyAssistantCompletesThinkingWithoutMessage()
    {
        Conversation conversation = CreateConversation(CurrentUserId);
        var repository = new FakeConversationRepository { Conversation = conversation };
        var agentClient = new FakeAgentConversationClient
        {
            Events =
            [
                new AgentServiceStreamEvent.MessageStarted("assistant"),
                new AgentServiceStreamEvent.ThinkingDelta(0, "private"),
                new AgentServiceStreamEvent.MessageCompleted("assistant"),
            ],
        };
        StreamConversationTurnHandler handler = CreateHandler(
            repository,
            new FakeFileAssetRepository(null),
            agentClient);

        List<ConversationStreamEvent> events = await CollectAsync(
            handler,
            new StreamConversationTurnCommand(conversation.Id, null, "Hello."),
            CancellationToken.None);

        Assert.Collection(
            events,
            item => Assert.IsType<ConversationStreamEvent.ResponseStarted>(item),
            item => Assert.IsType<ConversationStreamEvent.AssistantThinkingStarted>(item),
            item => Assert.IsType<ConversationStreamEvent.AssistantThinkingCompleted>(item));
    }

    [Fact]
    public async Task HandleAsync_MapsToolExecutionWithoutLeakingToolPayloads()
    {
        Conversation conversation = CreateConversation(CurrentUserId);
        var repository = new FakeConversationRepository { Conversation = conversation };
        var agentClient = new FakeAgentConversationClient
        {
            Events =
            [
                new AgentServiceStreamEvent.ToolExecutionStarted(
                    new AgentServiceToolCall("call-1", "lookup", "{\"query\":\"hello\"}")),
                new AgentServiceStreamEvent.ToolExecutionCompleted(
                    new AgentServiceToolCall("call-1", "lookup", "{\"query\":\"hello\"}"),
                    new AgentServiceToolResult("call-1", "lookup", ["secret result"], true, "{\"trace\":1}")),
            ],
        };
        StreamConversationTurnHandler handler = CreateHandler(
            repository,
            new FakeFileAssetRepository(null),
            agentClient);

        List<ConversationStreamEvent> events = await CollectAsync(
            handler,
            new StreamConversationTurnCommand(conversation.Id, null, "Hello."),
            CancellationToken.None);

        Assert.Collection(
            events,
            item => Assert.IsType<ConversationStreamEvent.ResponseStarted>(item),
            item => Assert.Equal(new ConversationStreamEvent.ToolExecutionStarted(
                "call-1",
                "lookup"), item),
            item => Assert.Equal(new ConversationStreamEvent.ToolExecutionCompleted(
                "call-1",
                "lookup",
                true), item));
    }

    [Fact]
    public async Task HandleAsync_MapsUsageAndCompactionFailureWithoutErrorDetails()
    {
        Conversation conversation = CreateConversation(CurrentUserId);
        var repository = new FakeConversationRepository { Conversation = conversation };
        var agentClient = new FakeAgentConversationClient
        {
            Events =
            [
                new AgentServiceStreamEvent.Usage(10, 4, 14),
                new AgentServiceStreamEvent.CompactionStarted("overflow"),
                new AgentServiceStreamEvent.CompactionCompleted("overflow", false, true, "secret"),
            ],
        };
        StreamConversationTurnHandler handler = CreateHandler(
            repository,
            new FakeFileAssetRepository(null),
            agentClient);

        List<ConversationStreamEvent> events = await CollectAsync(
            handler,
            new StreamConversationTurnCommand(conversation.Id, null, "Hello."),
            CancellationToken.None);

        Assert.Collection(
            events,
            item => Assert.IsType<ConversationStreamEvent.ResponseStarted>(item),
            item => Assert.Equal(new ConversationStreamEvent.Usage(10, 4, 14), item),
            item => Assert.Equal(new ConversationStreamEvent.ContextCompactionStarted("overflow"), item),
            item => Assert.Equal(new ConversationStreamEvent.ContextCompactionCompleted(
                "overflow",
                false,
                true,
                true), item));
    }

    [Fact]
    public async Task HandleAsync_IgnoresRuntimeAndUnknownAgentEvents()
    {
        Conversation conversation = CreateConversation(CurrentUserId);
        var repository = new FakeConversationRepository { Conversation = conversation };
        var agentClient = new FakeAgentConversationClient
        {
            Events =
            [
                new AgentServiceStreamEvent.AgentStarted(),
                new AgentServiceStreamEvent.AgentEnded(),
                new AgentServiceStreamEvent.TurnStarted(),
                new AgentServiceStreamEvent.TurnEnded(),
                new AgentServiceStreamEvent.ToolCallDelta(0, "call-1", "{}"),
                new AgentServiceStreamEvent.ToolCallCompleted(
                    0,
                    new AgentServiceToolCall("call-1", "lookup", "{}")),
                new AgentServiceStreamEvent.SessionSettled(),
                new AgentServiceStreamEvent.Unknown("retry_start", null, "{}"),
                new AgentServiceStreamEvent.SessionReady(FirstSessionId, true),
                new AgentServiceStreamEvent.Done(FirstSessionId, null, "completed"),
            ],
        };
        StreamConversationTurnHandler handler = CreateHandler(
            repository,
            new FakeFileAssetRepository(null),
            agentClient);

        List<ConversationStreamEvent> events = await CollectAsync(
            handler,
            new StreamConversationTurnCommand(conversation.Id, null, "Hello."),
            CancellationToken.None);

        Assert.Collection(
            events,
            item => Assert.IsType<ConversationStreamEvent.ResponseStarted>(item),
            item => Assert.IsType<ConversationStreamEvent.ResponseCompleted>(item));
    }

    [Fact]
    public async Task HandleAsync_PropagatesCancellationTokenToAgentStream()
    {
        Conversation conversation = CreateConversation(CurrentUserId);
        var repository = new FakeConversationRepository { Conversation = conversation };
        var agentClient = new FakeAgentConversationClient
        {
            Events =
            [
                new AgentServiceStreamEvent.SessionReady(FirstSessionId, true),
                new AgentServiceStreamEvent.Done(FirstSessionId, null, "completed"),
            ],
        };
        StreamConversationTurnHandler handler = CreateHandler(
            repository,
            new FakeFileAssetRepository(null),
            agentClient);
        using var cancellationSource = new CancellationTokenSource();

        await CollectAsync(
            handler,
            new StreamConversationTurnCommand(conversation.Id, null, "Hello."),
            cancellationSource.Token);

        Assert.Equal(cancellationSource.Token, agentClient.RequestedCancellationToken);
    }

    private static async Task<List<ConversationStreamEvent>> CollectAsync(
        StreamConversationTurnHandler handler,
        StreamConversationTurnCommand command,
        CancellationToken cancellationToken)
    {
        var events = new List<ConversationStreamEvent>();
        await foreach (ConversationStreamEvent streamEvent in handler.HandleAsync(
            command,
            cancellationToken))
        {
            events.Add(streamEvent);
        }

        return events;
    }

    private static StreamConversationTurnHandler CreateHandler(
        FakeConversationRepository repository,
        FakeFileAssetRepository fileRepository,
        FakeAgentConversationClient agentClient)
    {
        return new StreamConversationTurnHandler(
            new OpsPilot.Application.Files.GetById.GetFileAssetHandler(
                fileRepository,
                new FakeCurrentUser(CurrentUserId)),
            repository,
            new FakeCurrentUser(CurrentUserId),
            new FixedTimeProvider(new DateTimeOffset(StreamUpdatedAtUtc)),
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

        public Guid RequestedUserId { get; private set; }

        public Task<Conversation?> GetByIdAndUserIdAsync(
            Guid conversationId,
            Guid userId,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            GetCallCount++;
            RequestedUserId = userId;
            return Task.FromResult(
                Conversation?.Id == conversationId && Conversation.UserId == userId
                    ? Conversation
                    : null);
        }

        public Task AddAsync(Conversation conversation, CancellationToken cancellationToken) =>
            throw new NotSupportedException();

        public Task<IReadOnlyList<Conversation>> ListByUserIdAsync(
            Guid userId,
            CancellationToken cancellationToken) =>
            throw new NotSupportedException();

        public Task SaveChangesAsync(CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            SaveChangesCallCount++;
            return Task.CompletedTask;
        }
    }

    private sealed class FakeFileAssetRepository(FileAsset? fileAsset) : IFileAssetRepository
    {
        public int CallCount { get; private set; }

        public Guid RequestedUserId { get; private set; }

        public Task<FileAsset?> GetByIdAndUserIdAsync(
            Guid fileId,
            Guid userId,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            CallCount++;
            RequestedUserId = userId;
            return Task.FromResult(
                fileAsset?.Id == fileId && fileAsset.UserId == userId
                    ? fileAsset
                    : null);
        }

        public Task AddAsync(FileAsset fileAsset, CancellationToken cancellationToken) =>
            throw new NotSupportedException();

        public Task SaveChangesAsync(CancellationToken cancellationToken) =>
            throw new NotSupportedException();
    }

    private sealed class FakeAgentConversationClient : IAgentConversationClient
    {
        public IReadOnlyList<AgentServiceStreamEvent> Events { get; init; } = [];

        public Action<int>? BeforeYield { get; set; }

        public AgentConversationTurnRequest? Request { get; private set; }

        public CancellationToken RequestedCancellationToken { get; private set; }

        public int StreamCallCount { get; private set; }

        public Task<AgentConversationHistory> GetHistoryAsync(
            Guid sessionId,
            CancellationToken cancellationToken) =>
            throw new NotSupportedException();

        public Task<AgentConversationTurnResult> RunTurnAsync(
            AgentConversationTurnRequest request,
            CancellationToken cancellationToken) =>
            throw new NotSupportedException();

        public async IAsyncEnumerable<AgentServiceStreamEvent> StreamTurnAsync(
            AgentConversationTurnRequest request,
            [EnumeratorCancellation] CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            Request = request;
            RequestedCancellationToken = cancellationToken;
            StreamCallCount++;

            for (int index = 0; index < Events.Count; index++)
            {
                cancellationToken.ThrowIfCancellationRequested();
                BeforeYield?.Invoke(index);
                yield return Events[index];
            }
        }
    }
}
