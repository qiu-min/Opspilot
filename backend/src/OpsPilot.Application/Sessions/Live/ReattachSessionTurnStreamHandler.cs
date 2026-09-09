using System.Runtime.CompilerServices;
using OpsPilot.Application.Abstractions.AgentService;
using OpsPilot.Application.Abstractions.Persistence;
using OpsPilot.Application.Abstractions.Security;
using OpsPilot.Application.Exceptions;

namespace OpsPilot.Application.Sessions.Live;

public sealed class ReattachSessionTurnStreamHandler(ISessionRepository sessionRepository, ICurrentUser currentUser, IAgentSessionClient agentSessionClient)
{
    public async IAsyncEnumerable<AgentTurnStreamEvent> HandleAsync(Guid sessionId, Guid turnId, long? afterSequence, [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        if (await sessionRepository.GetByIdAndUserIdAsync(sessionId, currentUser.UserId, cancellationToken) is null)
            throw new ApplicationNotFoundException("Session not found.");
        AgentActiveTurnSnapshot? active = await agentSessionClient.GetActiveTurnAsync(sessionId, cancellationToken);
        if (active is null || active.TurnId != turnId)
            throw new ApplicationNotFoundException("Active Turn not found for Session.");
        await foreach (AgentTurnStreamEvent streamEvent in agentSessionClient.ReattachTurnStreamAsync(turnId, afterSequence, cancellationToken))
        {
            if (streamEvent.SessionId != sessionId || streamEvent.TurnId != turnId)
                throw new InvalidOperationException("Agent Service returned a different Turn identity.");
            yield return streamEvent;
        }
    }
}
