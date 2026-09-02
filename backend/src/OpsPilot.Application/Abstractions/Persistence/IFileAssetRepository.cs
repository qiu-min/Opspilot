using OpsPilot.Domain.Files;

namespace OpsPilot.Application.Abstractions.Persistence;

public interface IFileAssetRepository
{
    Task<FileAsset?> GetByIdAsync(
        Guid fileId,
        CancellationToken cancellationToken);

    Task<FileAsset?> GetByIdAndUserIdAsync(
        Guid fileId,
        Guid userId,
        CancellationToken cancellationToken);

    Task AddAsync(FileAsset fileAsset, CancellationToken cancellationToken);

    Task SaveChangesAsync(CancellationToken cancellationToken);
}
