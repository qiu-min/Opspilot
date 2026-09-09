using OpsPilot.Application.Abstractions.Persistence;
using OpsPilot.Application.Abstractions.Security;
using OpsPilot.Domain.Sessions;

namespace OpsPilot.Application.Sessions.List;

public sealed class ListSessionsHandler(ISessionRepository sessionRepository, ICurrentUser currentUser)
{
    public async Task<IReadOnlyList<SessionSummaryResult>> HandleAsync(ListSessionsQuery query, CancellationToken cancellationToken)
    {
        _ = query;
        IReadOnlyList<Session> sessions = await sessionRepository.ListByUserIdAsync(currentUser.UserId, cancellationToken);
        return sessions.Select(session => new SessionSummaryResult(session.Id, session.Title, session.UpdatedAtUtc)).ToArray();
    }
}
