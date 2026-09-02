using OpsPilot.Application.Abstractions.Persistence;
using OpsPilot.Application.Abstractions.Security;
using OpsPilot.Application.Exceptions;
using OpsPilot.Domain.Files;

namespace OpsPilot.Application.Files.GetById;

public sealed class GetFileAssetHandler(
    IFileAssetRepository fileAssetRepository,
    ICurrentUser currentUser)
{
    public async Task<GetFileAssetResult> HandleAsync(
        GetFileAssetQuery query,
        CancellationToken cancellationToken)
    {
        FileAsset? fileAsset = await fileAssetRepository.GetByIdAndUserIdAsync(
            query.FileId,
            currentUser.UserId,
            cancellationToken);

        if (fileAsset is null)
        {
            throw new ApplicationNotFoundException("File was not found.");
        }

        return new GetFileAssetResult(
            fileAsset.Id,
            fileAsset.OriginalFileName,
            fileAsset.ContentType,
            fileAsset.SizeBytes,
            fileAsset.StoragePath);
    }
}
