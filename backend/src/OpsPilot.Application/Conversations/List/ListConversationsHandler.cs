using OpsPilot.Application.Abstractions.Persistence;
using OpsPilot.Application.Abstractions.Security;
using OpsPilot.Domain.Conversations;

namespace OpsPilot.Application.Conversations.List;

public sealed class ListConversationsHandler(
    IConversationRepository conversationRepository,
    ICurrentUser currentUser)
{
    public async Task<IReadOnlyList<ConversationSummaryResult>> HandleAsync(
        ListConversationsQuery query,
        CancellationToken cancellationToken)
    {
        _ = query;

        IReadOnlyList<Conversation> conversations =
            await conversationRepository.ListByUserIdAsync(
                currentUser.UserId,
                cancellationToken);

        return conversations
            .Select(conversation => new ConversationSummaryResult(
                conversation.Id,
                conversation.Title,
                conversation.UpdatedAtUtc))
            .ToArray();
    }
}
