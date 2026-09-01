namespace OpsPilot.Application.Abstractions.AgentService;

public interface IAgentConversationClient
{
    Task<AgentConversationTurnResult> RunTurnAsync(
        AgentConversationTurnRequest request,
        CancellationToken cancellationToken);
}
