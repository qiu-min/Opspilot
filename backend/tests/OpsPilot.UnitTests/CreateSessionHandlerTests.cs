using OpsPilot.Application.Abstractions.AgentService;
using OpsPilot.Application.Abstractions.Persistence;
using OpsPilot.Application.Abstractions.Security;
using OpsPilot.Application.Sessions.Create;
using OpsPilot.Domain.Sessions;

namespace OpsPilot.UnitTests;

public sealed class CreateSessionHandlerTests
{
    [Fact]
    public async Task HandleAsync_UsesAgentServiceSessionIdForBackendRow()
    {
        Guid createdSessionId = Guid.Parse("33333333-3333-4333-8333-333333333333");
        Guid userId = Guid.Parse("44444444-4444-4444-8444-444444444444");
        var repository = new FakeSessionRepository();
        var handler = new CreateSessionHandler(repository, new FakeCurrentUser(userId), new FakeAgentSessionClient(createdSessionId));

        CreateSessionResult result = await handler.HandleAsync(new CreateSessionCommand(), CancellationToken.None);

        Assert.Equal(createdSessionId, result.Id);
        Assert.Equal(createdSessionId, repository.Session?.Id);
        Assert.Equal(userId, repository.Session?.UserId);
        Assert.True(repository.Saved);
    }

    private sealed class FakeCurrentUser(Guid userId) : ICurrentUser { public Guid UserId { get; } = userId; }
    private sealed class FakeSessionRepository : ISessionRepository
    {
        public Session? Session { get; private set; }
        public bool Saved { get; private set; }
        public Task<Session?> GetByIdAndUserIdAsync(Guid sessionId, Guid userId, CancellationToken cancellationToken) => Task.FromResult<Session?>(Session);
        public Task AddAsync(Session session, CancellationToken cancellationToken) { Session = session; return Task.CompletedTask; }
        public Task<IReadOnlyList<Session>> ListByUserIdAsync(Guid userId, CancellationToken cancellationToken) => Task.FromResult<IReadOnlyList<Session>>([]);
        public Task SaveChangesAsync(CancellationToken cancellationToken) { Saved = true; return Task.CompletedTask; }
    }
    private sealed class FakeAgentSessionClient(Guid sessionId) : IAgentSessionClient
    {
        public Task<AgentSessionCreated> CreateSessionAsync(CancellationToken cancellationToken) => Task.FromResult(new AgentSessionCreated(sessionId, DateTimeOffset.UtcNow, DateTimeOffset.UtcNow));
        public Task<AgentSessionHistory> GetHistoryAsync(Guid sessionId, CancellationToken cancellationToken) => throw new NotSupportedException();
        public Task<AgentTurnResult> RunTurnAsync(Guid sessionId, AgentTurnRequest request, CancellationToken cancellationToken) => throw new NotSupportedException();
        public IAsyncEnumerable<AgentTurnStreamEvent> StartTurnStreamAsync(Guid sessionId, AgentTurnRequest request, CancellationToken cancellationToken) => throw new NotSupportedException();
        public Task<AgentActiveTurnSnapshot?> GetActiveTurnAsync(Guid sessionId, CancellationToken cancellationToken) => throw new NotSupportedException();
        public IAsyncEnumerable<AgentTurnStreamEvent> ReattachTurnStreamAsync(Guid turnId, long? afterSequence, CancellationToken cancellationToken) => throw new NotSupportedException();
    }
}
