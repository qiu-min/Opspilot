using OpsPilot.Application.Abstractions.AgentService;
using OpsPilot.Application.Exceptions;
using OpsPilot.Application.Files.GetById;

namespace OpsPilot.Application.Conversations.RunTurn;

public sealed class RunConversationTurnHandler(
    GetFileAssetHandler getFileAssetHandler,
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
                command.SessionId,
                command.Message,
                excelResource),
            cancellationToken);

        return new RunConversationTurnResult(
            result.SessionId,
            result.LeafId,
            result.Status,
            result.Output);
    }
}
