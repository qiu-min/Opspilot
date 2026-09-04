using Microsoft.EntityFrameworkCore;
using OpsPilot.Application.Abstractions.Persistence;
using OpsPilot.Domain.Conversations;

namespace OpsPilot.Infrastructure.Persistence.Repositories;

public sealed class ConversationRepository(OpsPilotDbContext dbContext) : IConversationRepository
{
    public Task<Conversation?> GetByIdAndUserIdAsync(
        Guid conversationId,
        Guid userId,
        CancellationToken cancellationToken)
    {
        return dbContext.Conversations
            .SingleOrDefaultAsync(
                conversation =>
                    conversation.Id == conversationId &&
                    conversation.UserId == userId,
                cancellationToken);
    }

    public async Task AddAsync(
        Conversation conversation,
        CancellationToken cancellationToken)
    {
        await dbContext.Conversations.AddAsync(conversation, cancellationToken);
    }

    public async Task<IReadOnlyList<Conversation>> ListByUserIdAsync(
        Guid userId,
        CancellationToken cancellationToken)
    {
        return await dbContext.Conversations
            .AsNoTracking()
            .Where(conversation => conversation.UserId == userId)
            .OrderByDescending(conversation => conversation.UpdatedAtUtc)
            .ToListAsync(cancellationToken);
    }

    public Task SaveChangesAsync(CancellationToken cancellationToken)
    {
        return dbContext.SaveChangesAsync(cancellationToken);
    }
}
