using OpsPilot.Domain.Conversations;

namespace OpsPilot.Application.Abstractions.Persistence;

public interface IConversationRepository
{
    Task AddAsync(
        Conversation conversation,
        CancellationToken cancellationToken);

    Task<IReadOnlyList<Conversation>> ListByUserIdAsync(
        Guid userId,
        CancellationToken cancellationToken);

    Task SaveChangesAsync(CancellationToken cancellationToken);
}
