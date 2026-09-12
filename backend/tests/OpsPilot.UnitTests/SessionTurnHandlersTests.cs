using System.Runtime.CompilerServices;
using OpsPilot.Application.Abstractions.AgentService;
using OpsPilot.Application.Abstractions.Persistence;
using OpsPilot.Application.Abstractions.Security;
using OpsPilot.Application.Exceptions;
using OpsPilot.Application.Files.GetById;
using OpsPilot.Application.Sessions.GetDetail;
using OpsPilot.Application.Sessions.List;
using OpsPilot.Application.Sessions.Live;
using OpsPilot.Application.Sessions.RunTurn;
using OpsPilot.Application.Sessions.StreamTurn;
using OpsPilot.Domain.Files;
using OpsPilot.Domain.Sessions;

namespace OpsPilot.UnitTests;

public sealed class SessionTurnHandlersTests
{
    private static readonly Guid SessionId = Guid.Parse("55555555-5555-4555-8555-555555555555");
    private static readonly Guid TurnId = Guid.Parse("66666666-6666-4666-8666-666666666666");
    private static readonly Guid UserId = Guid.Parse("77777777-7777-4777-8777-777777777777");
    private static readonly DateTime CreatedAt = new(2026, 9, 9, 12, 0, 0, DateTimeKind.Utc);

    [Fact]
    public async Task List_UsesCurrentUserOwnershipFilter()
    {
        var repository = NewRepository();
        var currentUser = new FakeCurrentUser(UserId);

        IReadOnlyList<SessionSummaryResult> result = await new ListSessionsHandler(repository, currentUser)
            .HandleAsync(new ListSessionsQuery(), CancellationToken.None);

        Assert.Equal(UserId, repository.LastListedUserId);
        Assert.Single(result);
        Assert.Equal(SessionId, result[0].Id);
    }

    [Fact]
    public async Task GetDetail_MapsAgentSessionHistory()
    {
        var agent = new FakeAgentSessionClient
        {
            History = new AgentSessionHistory("leaf-1", [
                new AgentSessionHistoryMessageItem("message-1", "user", "inspect", CreatedAt),
                new AgentSessionHistoryToolExecutionItem("tool-1", "call-1", "lookup", "completed", CreatedAt.AddSeconds(1)),
            ], [
                new AgentTurnPresentationSummary(
                    TurnId,
                    SessionId,
                    "message-1",
                    "completed",
                    CreatedAt,
                    CreatedAt.AddSeconds(5),
                    new AgentTurnPresentationUsage(100, 40, 140),
                    [new AgentTurnToolPresentationSummary(
                        "call-1",
                        "lookup",
                        "completed",
                        new AgentToolDisplayInfo("Look up", "record-1", "Reading record"),
                        CreatedAt.AddSeconds(1),
                        CreatedAt.AddSeconds(2))])
            ]),
        };

        GetSessionDetailResult result = await new GetSessionDetailHandler(NewRepository(), new FakeCurrentUser(UserId), agent)
            .HandleAsync(new GetSessionDetailQuery(SessionId), CancellationToken.None);

        Assert.Equal(SessionId, result.Id);
        Assert.Collection(result.Items,
            item => Assert.IsType<SessionHistoryMessageItemResult>(item),
            item => Assert.IsType<SessionHistoryToolExecutionItemResult>(item));
        var summary = Assert.Single(result.TurnSummaries);
        Assert.Equal(TurnId, summary.TurnId);
        Assert.Equal("message-1", summary.InputEntryId);
        Assert.Equal("completed", summary.Status);
        Assert.Equal(CreatedAt, summary.StartedAt);
        Assert.Equal(CreatedAt.AddSeconds(5), summary.CompletedAt);
        Assert.Equal(140, summary.Usage!.TotalTokens);
        var tool = Assert.Single(summary.Tools);
        Assert.Equal("Look up", tool.Display!.Title);
        Assert.Equal(CreatedAt.AddSeconds(1), tool.StartedAt);
        Assert.Equal(CreatedAt.AddSeconds(2), tool.CompletedAt);
        Assert.Equal(SessionId, agent.LastHistorySessionId);
    }

    [Fact]
    public async Task GetDetail_DoesNotExposeAnotherUsersSession()
    {
        var repository = NewRepository();
        repository.Session = null;

        await Assert.ThrowsAsync<ApplicationNotFoundException>(() => new GetSessionDetailHandler(repository, new FakeCurrentUser(UserId), new FakeAgentSessionClient())
            .HandleAsync(new GetSessionDetailQuery(SessionId), CancellationToken.None));
    }

    [Fact]
    public async Task RunTurn_UsesRouteSessionIdAndTouchesMetadata()
    {
        var repository = NewRepository();
        var agent = new FakeAgentSessionClient { TurnResult = new AgentTurnResult(SessionId, TurnId, "leaf-2", "completed", "done") };
        var handler = new RunSessionTurnHandler(NewFileHandler(), repository, new FakeCurrentUser(UserId), new FixedTimeProvider(CreatedAt.AddMinutes(1)), agent);

        RunSessionTurnResult result = await handler.HandleAsync(new RunSessionTurnCommand(SessionId, null, "inspect"), CancellationToken.None);

        Assert.Equal(SessionId, result.SessionId);
        Assert.Equal(SessionId, agent.LastRunSessionId);
        Assert.Equal(new AgentTurnRequest("inspect", null), agent.LastRunRequest);
        Assert.Equal(CreatedAt.AddMinutes(1), repository.Session!.UpdatedAtUtc);
        Assert.True(repository.Saved);
    }

    [Fact]
    public async Task RunTurn_RejectsAgentSessionIdentityMismatch()
    {
        var agent = new FakeAgentSessionClient { TurnResult = new AgentTurnResult(Guid.NewGuid(), TurnId, null, "completed", "done") };
        var handler = new RunSessionTurnHandler(NewFileHandler(), NewRepository(), new FakeCurrentUser(UserId), new FixedTimeProvider(CreatedAt.AddMinutes(1)), agent);

        await Assert.ThrowsAsync<InvalidOperationException>(() => handler.HandleAsync(new RunSessionTurnCommand(SessionId, null, "inspect"), CancellationToken.None));
    }

    [Fact]
    public async Task StartStream_ForwardsTurnStreamEventsAndTouchesOnTurnStarted()
    {
        var repository = NewRepository();
        var agent = new FakeAgentSessionClient
        {
            StartEvents = [
                new AgentTurnStarted(TurnId, SessionId, 0, CreatedAt),
                new AgentAssistantTextDelta(TurnId, SessionId, 1, CreatedAt.AddMilliseconds(1), "hello"),
            ],
        };
        var handler = new StreamSessionTurnHandler(NewFileHandler(), repository, new FakeCurrentUser(UserId), new FixedTimeProvider(CreatedAt.AddMinutes(1)), agent);

        List<AgentTurnStreamEvent> events = await CollectAsync(handler.HandleAsync(new StreamSessionTurnCommand(SessionId, null, "inspect"), CancellationToken.None));

        Assert.Collection(events,
            item => Assert.IsType<AgentTurnStarted>(item),
            item => Assert.IsType<AgentAssistantTextDelta>(item));
        Assert.Equal(new AgentTurnRequest("inspect", null), agent.LastStreamRequest);
        Assert.Equal(CreatedAt.AddMinutes(1), repository.Session!.UpdatedAtUtc);
        Assert.True(repository.Saved);
    }

    [Fact]
    public async Task StartStream_MapsOwnedFileAssetToTheAgentExcelResource()
    {
        var file = FileAsset.Create(
            UserId,
            "report.xlsx",
            "stored.xlsx",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            3,
            "uploads/stored.xlsx",
            CreatedAt);
        var agent = new FakeAgentSessionClient
        {
            StartEvents = [new AgentTurnStarted(TurnId, SessionId, 0, CreatedAt)],
        };
        var handler = new StreamSessionTurnHandler(NewFileHandler(file), NewRepository(), new FakeCurrentUser(UserId), new FixedTimeProvider(CreatedAt.AddMinutes(1)), agent);

        await CollectAsync(handler.HandleAsync(new StreamSessionTurnCommand(SessionId, file.Id, "inspect"), CancellationToken.None));

        Assert.Equal(new AgentTurnRequest("inspect", new AgentExcelResource(file.Id, "uploads/stored.xlsx")), agent.LastStreamRequest);
    }

    [Fact]
    public async Task StartStream_RejectsAnotherSessionIdentity()
    {
        var agent = new FakeAgentSessionClient { StartEvents = [new AgentTurnStarted(TurnId, Guid.NewGuid(), 0, CreatedAt)] };
        var handler = new StreamSessionTurnHandler(NewFileHandler(), NewRepository(), new FakeCurrentUser(UserId), new FixedTimeProvider(CreatedAt.AddMinutes(1)), agent);

        await Assert.ThrowsAsync<InvalidOperationException>(() => CollectAsync(handler.HandleAsync(new StreamSessionTurnCommand(SessionId, null, "inspect"), CancellationToken.None)));
    }

    [Fact]
    public async Task ActiveTurn_UsesAgentProjectionAfterOwnershipCheck()
    {
        var active = new AgentActiveTurnSnapshot(TurnId, SessionId, "running", new AgentTurnStreamProjection(TurnId, SessionId, "running", new AgentTurnAssistantProjection("partial", true, false), [new AgentTurnToolProjection("call-1", "lookup", "completed", new AgentToolDisplayInfo("Look up", "record-1", "Reading record"), "2026-09-09T12:00:01Z", "2026-09-09T12:00:02Z")], new AgentTurnCompactionProjection("idle"), null, 7, "2026-09-09T12:00:00Z"));
        var agent = new FakeAgentSessionClient { ActiveTurn = active };

        AgentActiveTurnSnapshot? result = await new GetActiveSessionTurnHandler(NewRepository(), new FakeCurrentUser(UserId), agent)
            .HandleAsync(SessionId, CancellationToken.None);

        Assert.Same(active, result);
        Assert.Equal(SessionId, agent.LastActiveSessionId);
        Assert.Equal("2026-09-09T12:00:00Z", result!.Projection.StartedAt);
        Assert.Equal("2026-09-09T12:00:01Z", result.Projection.Tools[0].StartedAt);
        Assert.Equal("2026-09-09T12:00:02Z", result.Projection.Tools[0].CompletedAt);
        Assert.Equal("Look up", result.Projection.Tools[0].Display!.Title);
    }

    [Fact]
    public async Task ActiveTurn_RejectsUnknownSession()
    {
        var repository = NewRepository();
        repository.Session = null;

        await Assert.ThrowsAsync<ApplicationNotFoundException>(() => new GetActiveSessionTurnHandler(repository, new FakeCurrentUser(UserId), new FakeAgentSessionClient())
            .HandleAsync(SessionId, CancellationToken.None));
    }

    [Fact]
    public async Task Reattach_PassesAfterSequenceAndDoesNotRunANewTurn()
    {
        var agent = new FakeAgentSessionClient
        {
            ActiveTurn = new AgentActiveTurnSnapshot(TurnId, SessionId, "running", new AgentTurnStreamProjection(TurnId, SessionId, "running", new AgentTurnAssistantProjection("", false, false), [], new AgentTurnCompactionProjection("idle"), null, 20)),
            ReattachEvents = [new AgentAssistantTextDelta(TurnId, SessionId, 21, CreatedAt, "continued")],
        };
        var handler = new ReattachSessionTurnStreamHandler(NewRepository(), new FakeCurrentUser(UserId), agent);

        List<AgentTurnStreamEvent> events = await CollectAsync(handler.HandleAsync(SessionId, TurnId, 20, CancellationToken.None));

        Assert.Single(events);
        Assert.Equal(20, agent.LastAfterSequence);
        Assert.Equal(0, agent.RunTurnCalls);
        Assert.Equal(TurnId, agent.LastReattachTurnId);
    }

    [Fact]
    public async Task Reattach_RejectsTurnThatIsNotActiveForSession()
    {
        var agent = new FakeAgentSessionClient
        {
            ActiveTurn = new AgentActiveTurnSnapshot(Guid.NewGuid(), SessionId, "running", new AgentTurnStreamProjection(Guid.NewGuid(), SessionId, "running", new AgentTurnAssistantProjection("", false, false), [], new AgentTurnCompactionProjection("idle"), null, 1)),
        };
        var handler = new ReattachSessionTurnStreamHandler(NewRepository(), new FakeCurrentUser(UserId), agent);

        await Assert.ThrowsAsync<ApplicationNotFoundException>(() => CollectAsync(handler.HandleAsync(SessionId, TurnId, 1, CancellationToken.None)));
    }

    private static FakeSessionRepository NewRepository() => new() { Session = Session.Create(SessionId, UserId, Session.DefaultTitle, CreatedAt) };
    private static GetFileAssetHandler NewFileHandler(FileAsset? fileAsset = null) => new(new FakeFileAssetRepository(fileAsset), new FakeCurrentUser(UserId));

    private static async Task<List<AgentTurnStreamEvent>> CollectAsync(IAsyncEnumerable<AgentTurnStreamEvent> events)
    {
        var result = new List<AgentTurnStreamEvent>();
        await foreach (AgentTurnStreamEvent streamEvent in events) result.Add(streamEvent);
        return result;
    }

    private sealed class FakeCurrentUser(Guid userId) : ICurrentUser { public Guid UserId { get; } = userId; }

    private sealed class FixedTimeProvider(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }

    private sealed class FakeSessionRepository : ISessionRepository
    {
        public Session? Session { get; set; }
        public bool Saved { get; private set; }
        public Guid? LastListedUserId { get; private set; }
        public Task<Session?> GetByIdAndUserIdAsync(Guid sessionId, Guid userId, CancellationToken cancellationToken) => Task.FromResult(Session?.Id == sessionId && Session.UserId == userId ? Session : null);
        public Task AddAsync(Session session, CancellationToken cancellationToken) { Session = session; return Task.CompletedTask; }
        public Task<IReadOnlyList<Session>> ListByUserIdAsync(Guid userId, CancellationToken cancellationToken) { LastListedUserId = userId; return Task.FromResult<IReadOnlyList<Session>>(Session is null || Session.UserId != userId ? [] : [Session]); }
        public Task SaveChangesAsync(CancellationToken cancellationToken) { Saved = true; return Task.CompletedTask; }
    }

    private sealed class FakeFileAssetRepository(FileAsset? fileAsset = null) : IFileAssetRepository
    {
        public Task<FileAsset?> GetByIdAndUserIdAsync(Guid fileId, Guid userId, CancellationToken cancellationToken) => Task.FromResult(fileAsset is not null && fileAsset.Id == fileId && fileAsset.UserId == userId ? fileAsset : null);
        public Task AddAsync(FileAsset fileAsset, CancellationToken cancellationToken) => Task.CompletedTask;
        public Task SaveChangesAsync(CancellationToken cancellationToken) => Task.CompletedTask;
    }

    private sealed class FakeAgentSessionClient : IAgentSessionClient
    {
        public AgentSessionHistory History { get; init; } = new(null, []);
        public AgentTurnResult TurnResult { get; init; } = new(SessionId, TurnId, null, "completed", "done");
        public AgentActiveTurnSnapshot? ActiveTurn { get; init; }
        public IReadOnlyList<AgentTurnStreamEvent> StartEvents { get; init; } = [];
        public IReadOnlyList<AgentTurnStreamEvent> ReattachEvents { get; init; } = [];
        public Guid? LastHistorySessionId { get; private set; }
        public Guid? LastRunSessionId { get; private set; }
        public AgentTurnRequest? LastRunRequest { get; private set; }
        public AgentTurnRequest? LastStreamRequest { get; private set; }
        public Guid? LastActiveSessionId { get; private set; }
        public Guid? LastReattachTurnId { get; private set; }
        public long? LastAfterSequence { get; private set; }
        public int RunTurnCalls { get; private set; }

        public Task<AgentSessionCreated> CreateSessionAsync(CancellationToken cancellationToken) => throw new NotSupportedException();
        public Task<AgentSessionHistory> GetHistoryAsync(Guid sessionId, CancellationToken cancellationToken) { LastHistorySessionId = sessionId; return Task.FromResult(History); }
        public Task<AgentTurnResult> RunTurnAsync(Guid sessionId, AgentTurnRequest request, CancellationToken cancellationToken) { LastRunSessionId = sessionId; LastRunRequest = request; RunTurnCalls++; return Task.FromResult(TurnResult); }
        public IAsyncEnumerable<AgentTurnStreamEvent> StartTurnStreamAsync(Guid sessionId, AgentTurnRequest request, CancellationToken cancellationToken) { LastStreamRequest = request; return Yield(StartEvents, cancellationToken); }
        public Task<AgentActiveTurnSnapshot?> GetActiveTurnAsync(Guid sessionId, CancellationToken cancellationToken) { LastActiveSessionId = sessionId; return Task.FromResult(ActiveTurn); }
        public IAsyncEnumerable<AgentTurnStreamEvent> ReattachTurnStreamAsync(Guid turnId, long? afterSequence, CancellationToken cancellationToken) { LastReattachTurnId = turnId; LastAfterSequence = afterSequence; return Yield(ReattachEvents, cancellationToken); }

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
}
