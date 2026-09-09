using OpsPilot.Domain.Sessions;

namespace OpsPilot.Application.Abstractions.Persistence;

public interface ISessionRepository
{
    Task<Session?> GetByIdAndUserIdAsync(Guid sessionId, Guid userId, CancellationToken cancellationToken);
    Task AddAsync(Session session, CancellationToken cancellationToken);
    Task<IReadOnlyList<Session>> ListByUserIdAsync(Guid userId, CancellationToken cancellationToken);
    Task SaveChangesAsync(CancellationToken cancellationToken);
}
