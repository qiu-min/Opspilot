namespace OpsPilot.Application.Abstractions.AgentService;

public interface IAgentSessionClient
{
    Task<AgentSessionCreated> CreateSessionAsync(CancellationToken cancellationToken);
    Task<AgentSessionHistory> GetHistoryAsync(Guid sessionId, CancellationToken cancellationToken);
    Task<AgentTurnResult> RunTurnAsync(Guid sessionId, AgentTurnRequest request, CancellationToken cancellationToken);
    IAsyncEnumerable<AgentTurnStreamEvent> StartTurnStreamAsync(Guid sessionId, AgentTurnRequest request, CancellationToken cancellationToken);
    Task<AgentActiveTurnSnapshot?> GetActiveTurnAsync(Guid sessionId, CancellationToken cancellationToken);
    IAsyncEnumerable<AgentTurnStreamEvent> ReattachTurnStreamAsync(Guid turnId, long? afterSequence, CancellationToken cancellationToken);
}

public sealed record AgentSessionCreated(Guid SessionId, DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt);
