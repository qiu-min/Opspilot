namespace OpsPilot.Application.Abstractions.AgentService;

public interface IAgentConversationClient
{
    Task<AgentConversationHistory> GetHistoryAsync(
        Guid sessionId,
        CancellationToken cancellationToken);

    Task<AgentConversationTurnResult> RunTurnAsync(
        AgentConversationTurnRequest request,
        CancellationToken cancellationToken);

    IAsyncEnumerable<AgentServiceStreamEvent> StreamTurnAsync(
        AgentConversationTurnRequest request,
        CancellationToken cancellationToken);
}
