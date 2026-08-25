using OpsPilot.Domain.Files;

namespace OpsPilot.Application.Abstractions.Persistence;

public interface IFileAssetRepository
{
    Task AddAsync(FileAsset fileAsset, CancellationToken cancellationToken);

    Task SaveChangesAsync(CancellationToken cancellationToken);
}
