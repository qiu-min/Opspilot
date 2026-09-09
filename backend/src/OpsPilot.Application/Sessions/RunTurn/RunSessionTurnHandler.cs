using OpsPilot.Application.Abstractions.AgentService;
using OpsPilot.Application.Abstractions.Persistence;
using OpsPilot.Application.Abstractions.Security;
using OpsPilot.Application.Exceptions;
using OpsPilot.Application.Files.GetById;
using OpsPilot.Domain.Sessions;

namespace OpsPilot.Application.Sessions.RunTurn;

public sealed class RunSessionTurnHandler(
    GetFileAssetHandler getFileAssetHandler,
    ISessionRepository sessionRepository,
    ICurrentUser currentUser,
    TimeProvider timeProvider,
    IAgentSessionClient agentSessionClient)
{
    public async Task<RunSessionTurnResult> HandleAsync(RunSessionTurnCommand command, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(command.Message)) throw new ApplicationValidationException("Message cannot be empty.");
        Session? session = await sessionRepository.GetByIdAndUserIdAsync(command.SessionId, currentUser.UserId, cancellationToken);
        if (session is null) throw new ApplicationNotFoundException("Session not found.");
        AgentExcelResource? excel = command.FileId is Guid fileId
            ? MapFile(await getFileAssetHandler.HandleAsync(new GetFileAssetQuery(fileId), cancellationToken))
            : null;
        AgentTurnResult result = await agentSessionClient.RunTurnAsync(command.SessionId, new AgentTurnRequest(command.Message, excel), cancellationToken);
        EnsureSession(command.SessionId, result.SessionId);
        session.Touch(timeProvider.GetUtcNow().UtcDateTime);
        await sessionRepository.SaveChangesAsync(cancellationToken);
        return new RunSessionTurnResult(command.SessionId, result.TurnId, result.LeafId, result.Status, result.Output);
    }

    private static AgentExcelResource MapFile(GetFileAssetResult file) => new(file.Id, file.StoragePath);
    private static void EnsureSession(Guid expected, Guid actual)
    {
        if (expected != actual) throw new InvalidOperationException("Agent Service returned a different session identity.");
    }
}
