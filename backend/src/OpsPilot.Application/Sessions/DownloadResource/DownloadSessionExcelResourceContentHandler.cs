using OpsPilot.Application.Abstractions.AgentService;
using OpsPilot.Application.Abstractions.Persistence;
using OpsPilot.Application.Abstractions.Security;
using OpsPilot.Application.Exceptions;
using OpsPilot.Application.Files.GetById;

namespace OpsPilot.Application.Sessions.DownloadResource;

/// <summary>Authorizes a Session workbook download before proxying its committed Agent content.</summary>
public sealed class DownloadSessionExcelResourceContentHandler(
    ISessionRepository sessionRepository,
    ICurrentUser currentUser,
    GetFileAssetHandler getFileAssetHandler,
    IAgentSessionClient agentSessionClient)
{
    public async Task<AgentExcelResourceContent> HandleAsync(
        Guid sessionId,
        Guid resourceId,
        CancellationToken cancellationToken)
    {
        if (await sessionRepository.GetByIdAndUserIdAsync(sessionId, currentUser.UserId, cancellationToken) is null)
        {
            throw new ApplicationNotFoundException("Session not found.");
        }

        GetFileAssetResult file = await getFileAssetHandler.HandleAsync(
            new GetFileAssetQuery(resourceId),
            cancellationToken);
        AgentExcelResourceContent content = await agentSessionClient.GetExcelResourceContentAsync(
            sessionId,
            resourceId,
            cancellationToken);

        string fileName = Path.GetFileName(file.OriginalFileName);
        return content with { FileName = string.IsNullOrWhiteSpace(fileName) ? "workbook.xlsx" : fileName };
    }
}
