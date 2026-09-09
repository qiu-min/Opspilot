using OpsPilot.Application.Abstractions.AgentService;
using OpsPilot.Application.Abstractions.Persistence;
using OpsPilot.Application.Abstractions.Security;
using OpsPilot.Application.Exceptions;

namespace OpsPilot.Application.Sessions.Live;

public sealed class GetActiveSessionTurnHandler(ISessionRepository sessionRepository, ICurrentUser currentUser, IAgentSessionClient agentSessionClient)
{
    public async Task<AgentActiveTurnSnapshot?> HandleAsync(Guid sessionId, CancellationToken cancellationToken)
    {
        if (await sessionRepository.GetByIdAndUserIdAsync(sessionId, currentUser.UserId, cancellationToken) is null)
            throw new ApplicationNotFoundException("Session not found.");
        return await agentSessionClient.GetActiveTurnAsync(sessionId, cancellationToken);
    }
}
