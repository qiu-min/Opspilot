using OpsPilot.Application.Abstractions.AgentService;
using OpsPilot.Application.Abstractions.Persistence;
using OpsPilot.Application.Abstractions.Security;
using OpsPilot.Application.Exceptions;
using OpsPilot.Application.Files.GetById;
using OpsPilot.Domain.Conversations;

namespace OpsPilot.Application.Conversations.RunTurn;

public sealed class RunConversationTurnHandler(
    GetFileAssetHandler getFileAssetHandler,
    IConversationRepository conversationRepository,
    ICurrentUser currentUser,
    TimeProvider timeProvider,
    IAgentConversationClient agentConversationClient)
{
    public async Task<RunConversationTurnResult> HandleAsync(
        RunConversationTurnCommand command,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(command.Message))
        {
            throw new ApplicationValidationException("Message cannot be empty.");
        }

        Guid userId = currentUser.UserId;
        Conversation? conversation = await conversationRepository.GetByIdAndUserIdAsync(
            command.ConversationId,
            userId,
            cancellationToken);
        if (conversation is null)
        {
            throw new ApplicationNotFoundException("Conversation not found.");
        }

        AgentExcelResource? excelResource = null;
        if (command.FileId is Guid fileId)
        {
            GetFileAssetResult fileAsset = await getFileAssetHandler.HandleAsync(
                new GetFileAssetQuery(fileId),
                cancellationToken);

            excelResource = new AgentExcelResource(fileAsset.Id, fileAsset.StoragePath);
        }

        AgentConversationTurnResult result = await agentConversationClient.RunTurnAsync(
            new AgentConversationTurnRequest(
                conversation.AgentSessionId,
                command.Message,
                excelResource),
            cancellationToken);

        DateTime updatedAtUtc = timeProvider.GetUtcNow().UtcDateTime;
        conversation.BindAgentSession(result.SessionId, updatedAtUtc);
        await conversationRepository.SaveChangesAsync(cancellationToken);

        return new RunConversationTurnResult(
            command.ConversationId,
            result.LeafId,
            result.Status,
            result.Output);
    }
}
