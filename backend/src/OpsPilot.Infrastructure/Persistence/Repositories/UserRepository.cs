using Microsoft.EntityFrameworkCore;
using Npgsql;
using OpsPilot.Application.Abstractions.Persistence;
using OpsPilot.Application.Exceptions;
using OpsPilot.Domain.Users;
using OpsPilot.Infrastructure.Persistence.Configurations;

namespace OpsPilot.Infrastructure.Persistence.Repositories;

public sealed class UserRepository(OpsPilotDbContext dbContext) : IUserRepository
{
    public Task<User?> GetByEmailAsync(
        string email,
        CancellationToken cancellationToken)
    {
        string normalizedEmail = email.Trim().ToLowerInvariant();

        return dbContext.Users
            .AsNoTracking()
            .SingleOrDefaultAsync(
                user => user.Email == normalizedEmail,
                cancellationToken);
    }

    public Task<User?> GetByIdAsync(
        Guid userId,
        CancellationToken cancellationToken)
    {
        return dbContext.Users
            .AsNoTracking()
            .SingleOrDefaultAsync(
                user => user.Id == userId,
                cancellationToken);
    }

    public async Task AddAsync(User user, CancellationToken cancellationToken)
    {
        await dbContext.Users.AddAsync(user, cancellationToken);
    }

    public async Task SaveChangesAsync(CancellationToken cancellationToken)
    {
        try
        {
            await dbContext.SaveChangesAsync(cancellationToken);
        }
        catch (DbUpdateException exception) when (IsDuplicateEmail(exception))
        {
            throw new ApplicationConflictException(
                "A user with this email already exists.",
                exception);
        }
    }

    private static bool IsDuplicateEmail(DbUpdateException exception)
    {
        return exception.InnerException is PostgresException postgresException &&
            postgresException.SqlState == PostgresErrorCodes.UniqueViolation &&
            string.Equals(
                postgresException.ConstraintName,
                UserConfiguration.EmailIndexName,
                StringComparison.Ordinal);
    }
}
