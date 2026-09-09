using OpsPilot.Application.Abstractions.AgentService;
using OpsPilot.Application.Abstractions.Persistence;
using OpsPilot.Application.Abstractions.Security;
using OpsPilot.Domain.Sessions;

namespace OpsPilot.Application.Sessions.Create;

public sealed class CreateSessionHandler(
    ISessionRepository sessionRepository,
    ICurrentUser currentUser,
    IAgentSessionClient agentSessionClient)
{
    public async Task<CreateSessionResult> HandleAsync(CreateSessionCommand command, CancellationToken cancellationToken)
    {
        _ = command;
        AgentSessionCreated created = await agentSessionClient.CreateSessionAsync(cancellationToken);
        DateTime createdAtUtc = created.CreatedAt.UtcDateTime;
        Session session = Session.Create(created.SessionId, currentUser.UserId, Session.DefaultTitle, createdAtUtc);
        await sessionRepository.AddAsync(session, cancellationToken);
        await sessionRepository.SaveChangesAsync(cancellationToken);
        return new CreateSessionResult(session.Id, session.Title, session.CreatedAtUtc, session.UpdatedAtUtc);
    }
}
