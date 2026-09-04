using OpsPilot.Application.Abstractions.Persistence;
using OpsPilot.Application.Abstractions.Security;
using OpsPilot.Domain.Conversations;

namespace OpsPilot.Application.Conversations.Create;

public sealed class CreateConversationHandler(
    IConversationRepository conversationRepository,
    ICurrentUser currentUser,
    TimeProvider timeProvider)
{
    public async Task<CreateConversationResult> HandleAsync(
        CreateConversationCommand command,
        CancellationToken cancellationToken)
    {
        _ = command;

        Guid userId = currentUser.UserId;
        DateTime now = timeProvider.GetUtcNow().UtcDateTime;
        Conversation conversation = Conversation.Create(
            userId,
            Conversation.DefaultTitle,
            now);

        await conversationRepository.AddAsync(conversation, cancellationToken);
        await conversationRepository.SaveChangesAsync(cancellationToken);

        return new CreateConversationResult(
            conversation.Id,
            conversation.Title,
            conversation.CreatedAtUtc,
            conversation.UpdatedAtUtc);
    }
}
