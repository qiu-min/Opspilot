using System.Runtime.CompilerServices;
using OpsPilot.Application.Abstractions.AgentService;
using OpsPilot.Application.Abstractions.Persistence;
using OpsPilot.Application.Abstractions.Security;
using OpsPilot.Application.Exceptions;
using OpsPilot.Application.Files.GetById;
using OpsPilot.Domain.Sessions;

namespace OpsPilot.Application.Sessions.StreamTurn;

public sealed class StreamSessionTurnHandler(
    GetFileAssetHandler getFileAssetHandler,
    ISessionRepository sessionRepository,
    ICurrentUser currentUser,
    TimeProvider timeProvider,
    IAgentSessionClient agentSessionClient)
{
    public async IAsyncEnumerable<AgentTurnStreamEvent> HandleAsync(StreamSessionTurnCommand command, [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(command.Message)) throw new ApplicationValidationException("Message cannot be empty.");
        Session? session = await sessionRepository.GetByIdAndUserIdAsync(command.SessionId, currentUser.UserId, cancellationToken);
        if (session is null) throw new ApplicationNotFoundException("Session not found.");
        AgentExcelResource? excel = command.FileId is Guid fileId
            ? MapFile(await getFileAssetHandler.HandleAsync(new GetFileAssetQuery(fileId), cancellationToken))
            : null;
        bool touched = false;
        await foreach (AgentTurnStreamEvent streamEvent in agentSessionClient.StartTurnStreamAsync(
            command.SessionId, new AgentTurnRequest(command.Message, excel), cancellationToken))
        {
            if (streamEvent.SessionId != command.SessionId)
                throw new InvalidOperationException("Agent Service returned a different session identity.");
            if (!touched && streamEvent is AgentTurnStarted)
            {
                session.Touch(timeProvider.GetUtcNow().UtcDateTime);
                await sessionRepository.SaveChangesAsync(cancellationToken);
                touched = true;
            }
            yield return streamEvent;
        }
    }

    private static AgentExcelResource MapFile(GetFileAssetResult file) => new(file.Id, file.StoragePath);
}
