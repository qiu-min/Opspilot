using Microsoft.EntityFrameworkCore;
using OpsPilot.Application.Abstractions.Persistence;
using OpsPilot.Domain.Files;

namespace OpsPilot.Infrastructure.Persistence.Repositories;

public sealed class FileAssetRepository(OpsPilotDbContext dbContext) : IFileAssetRepository
{
    public Task<FileAsset?> GetByIdAsync(
        Guid fileId,
        CancellationToken cancellationToken)
    {
        return dbContext.FileAssets
            .AsNoTracking()
            .SingleOrDefaultAsync(
                fileAsset => fileAsset.Id == fileId,
                cancellationToken);
    }

    public async Task AddAsync(
        FileAsset fileAsset,
        CancellationToken cancellationToken)
    {
        await dbContext.FileAssets.AddAsync(fileAsset, cancellationToken);
    }

    public Task SaveChangesAsync(CancellationToken cancellationToken)
    {
        return dbContext.SaveChangesAsync(cancellationToken);
    }
}
