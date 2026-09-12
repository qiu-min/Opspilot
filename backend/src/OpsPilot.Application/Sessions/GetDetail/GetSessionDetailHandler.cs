using OpsPilot.Application.Abstractions.AgentService;
using OpsPilot.Application.Abstractions.Persistence;
using OpsPilot.Application.Abstractions.Security;
using OpsPilot.Application.Exceptions;
using OpsPilot.Domain.Sessions;

namespace OpsPilot.Application.Sessions.GetDetail;

public sealed class GetSessionDetailHandler(ISessionRepository sessionRepository, ICurrentUser currentUser, IAgentSessionClient agentSessionClient)
{
    public async Task<GetSessionDetailResult> HandleAsync(GetSessionDetailQuery query, CancellationToken cancellationToken)
    {
        Session? session = await sessionRepository.GetByIdAndUserIdAsync(query.SessionId, currentUser.UserId, cancellationToken);
        if (session is null) throw new ApplicationNotFoundException("Session not found.");
        AgentSessionHistory history = await agentSessionClient.GetHistoryAsync(session.Id, cancellationToken);
        return new GetSessionDetailResult(session.Id, session.Title, session.CreatedAtUtc, session.UpdatedAtUtc,
            history.Items.Select(MapHistoryItem).ToArray(),
            (history.TurnSummaries ?? []).Select(MapTurnSummary).ToArray());
    }

    private static SessionHistoryItemResult MapHistoryItem(AgentSessionHistoryItem item) => item switch
    {
        AgentSessionHistoryMessageItem message => new SessionHistoryMessageItemResult(message.Id, message.Role, message.Text, message.CreatedAt),
        AgentSessionHistoryToolExecutionItem tool => new SessionHistoryToolExecutionItemResult(tool.Id, tool.CallId, tool.Name, tool.Status, tool.CreatedAt),
        _ => throw new InvalidOperationException($"Unsupported Agent Service history item: {item.GetType().Name}.")
    };

    private static SessionTurnPresentationSummaryResult MapTurnSummary(AgentTurnPresentationSummary summary) =>
        new(
            summary.TurnId,
            summary.SessionId,
            summary.InputEntryId,
            summary.Status,
            summary.StartedAt,
            summary.CompletedAt,
            summary.Usage is null
                ? null
                : new SessionTurnPresentationUsageResult(
                    summary.Usage.InputTokens,
                    summary.Usage.OutputTokens,
                    summary.Usage.TotalTokens),
            summary.Tools.Select(tool => new SessionToolPresentationSummaryResult(
                tool.CallId,
                tool.Name,
                tool.Status,
                tool.Display is null
                    ? null
                    : new AgentServiceToolDisplayResult(
                        tool.Display.Title,
                        tool.Display.Subject,
                        tool.Display.Detail),
                tool.StartedAt,
                tool.CompletedAt)).ToArray());
}
