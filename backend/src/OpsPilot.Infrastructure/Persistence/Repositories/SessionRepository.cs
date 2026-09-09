using Microsoft.EntityFrameworkCore;
using OpsPilot.Application.Abstractions.Persistence;
using OpsPilot.Domain.Sessions;

namespace OpsPilot.Infrastructure.Persistence.Repositories;

public sealed class SessionRepository(OpsPilotDbContext dbContext) : ISessionRepository
{
    public Task<Session?> GetByIdAndUserIdAsync(Guid sessionId, Guid userId, CancellationToken cancellationToken) =>
        dbContext.Sessions.SingleOrDefaultAsync(session => session.Id == sessionId && session.UserId == userId, cancellationToken);

    public async Task AddAsync(Session session, CancellationToken cancellationToken) =>
        await dbContext.Sessions.AddAsync(session, cancellationToken);

    public async Task<IReadOnlyList<Session>> ListByUserIdAsync(Guid userId, CancellationToken cancellationToken) =>
        await dbContext.Sessions.AsNoTracking().Where(session => session.UserId == userId)
            .OrderByDescending(session => session.UpdatedAtUtc).ToListAsync(cancellationToken);

    public Task SaveChangesAsync(CancellationToken cancellationToken) => dbContext.SaveChangesAsync(cancellationToken);
}
