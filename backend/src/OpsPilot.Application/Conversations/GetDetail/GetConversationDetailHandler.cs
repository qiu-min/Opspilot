using OpsPilot.Application.Abstractions.AgentService;
using OpsPilot.Application.Abstractions.Persistence;
using OpsPilot.Application.Abstractions.Security;
using OpsPilot.Application.Exceptions;
using OpsPilot.Domain.Conversations;

namespace OpsPilot.Application.Conversations.GetDetail;

public sealed class GetConversationDetailHandler(
    IConversationRepository conversationRepository,
    ICurrentUser currentUser,
    IAgentConversationClient agentConversationClient)
{
    public async Task<GetConversationDetailResult> HandleAsync(
        GetConversationDetailQuery query,
        CancellationToken cancellationToken)
    {
        Conversation? conversation = await conversationRepository.GetByIdAndUserIdAsync(
            query.ConversationId,
            currentUser.UserId,
            cancellationToken);
        if (conversation is null)
        {
            throw new ApplicationNotFoundException("Conversation not found.");
        }

        IReadOnlyList<ConversationHistoryItemResult> items = [];
        if (conversation.AgentSessionId is Guid agentSessionId)
        {
            AgentConversationHistory history = await agentConversationClient.GetHistoryAsync(
                agentSessionId,
                cancellationToken);

            items = history.Items
                .Select(MapHistoryItem)
                .ToArray();
        }

        return new GetConversationDetailResult(
            conversation.Id,
            conversation.Title,
            conversation.CreatedAtUtc,
            conversation.UpdatedAtUtc,
            items);
    }

    private static ConversationHistoryItemResult MapHistoryItem(
        AgentConversationHistoryItem item) =>
        item switch
        {
            AgentConversationHistoryMessageItem message =>
                new ConversationHistoryMessageItemResult(
                    message.Id,
                    message.Role,
                    message.Text,
                    message.CreatedAt),
            AgentConversationHistoryToolExecutionItem toolExecution =>
                new ConversationHistoryToolExecutionItemResult(
                    toolExecution.Id,
                    toolExecution.CallId,
                    toolExecution.Name,
                    toolExecution.Status,
                    toolExecution.CreatedAt),
            _ => throw new InvalidOperationException(
                $"Unsupported conversation history item type: {item.GetType().Name}."),
        };
}
