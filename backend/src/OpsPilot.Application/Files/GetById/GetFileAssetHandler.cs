using OpsPilot.Application.Abstractions.Persistence;
using OpsPilot.Domain.Files;

namespace OpsPilot.Application.Files.GetById;

public sealed class GetFileAssetHandler(
    IFileAssetRepository fileAssetRepository)
{
    public async Task<GetFileAssetResult?> HandleAsync(
        GetFileAssetQuery query,
        CancellationToken cancellationToken)
    {
        FileAsset? fileAsset = await fileAssetRepository.GetByIdAsync(
            query.FileId,
            cancellationToken);

        if (fileAsset is null)
        {
            return null;
        }

        return new GetFileAssetResult(
            fileAsset.Id,
            fileAsset.OriginalFileName,
            fileAsset.ContentType,
            fileAsset.SizeBytes,
            fileAsset.StoragePath);
    }
}
