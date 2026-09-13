using OpsPilot.Application.Abstractions.AgentService;
using OpsPilot.Application.Abstractions.Persistence;
using OpsPilot.Application.Abstractions.Security;
using OpsPilot.Application.Exceptions;

namespace OpsPilot.Application.Sessions.Trace;

public sealed class GetSessionTurnTraceHandler(
    ISessionRepository sessionRepository,
    ICurrentUser currentUser,
    IAgentSessionClient agentSessionClient)
{
    public async Task<GetSessionTurnTraceResult> HandleAsync(
        GetSessionTurnTraceQuery query,
        CancellationToken cancellationToken)
    {
        if (await sessionRepository.GetByIdAndUserIdAsync(
                query.SessionId,
                currentUser.UserId,
                cancellationToken) is null)
        {
            throw new ApplicationNotFoundException("Session not found.");
        }

        AgentTurnTrace trace = await agentSessionClient.GetTurnTraceAsync(
            query.TurnId,
            cancellationToken);
        if (trace.TurnId != query.TurnId || trace.SessionId != query.SessionId)
        {
            throw new ApplicationNotFoundException("Turn not found for Session.");
        }

        return new GetSessionTurnTraceResult(trace);
    }
}
