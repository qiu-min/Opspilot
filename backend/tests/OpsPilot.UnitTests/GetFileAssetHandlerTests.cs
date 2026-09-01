using OpsPilot.Application.Abstractions.Persistence;
using OpsPilot.Application.Files.GetById;
using OpsPilot.Domain.Files;

namespace OpsPilot.UnitTests;

public sealed class GetFileAssetHandlerTests
{
    [Fact]
    public async Task HandleAsync_WhenFileAssetExists_MapsRepositoryEntityToResult()
    {
        DateTime createdAtUtc = new(2026, 8, 25, 12, 0, 0, DateTimeKind.Utc);
        FileAsset fileAsset = FileAsset.Create(
            "report.xlsx",
            "stored-report.xlsx",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            1234,
            "uploads/stored-report.xlsx",
            createdAtUtc);
        using var cancellationSource = new CancellationTokenSource();
        var repository = new FakeFileAssetRepository(fileAsset);
        var handler = new GetFileAssetHandler(repository);

        GetFileAssetResult? result = await handler.HandleAsync(
            new GetFileAssetQuery(fileAsset.Id),
            cancellationSource.Token);

        Assert.NotNull(result);
        Assert.Equal(fileAsset.Id, result!.Id);
        Assert.Equal(fileAsset.OriginalFileName, result.OriginalFileName);
        Assert.Equal(fileAsset.ContentType, result.ContentType);
        Assert.Equal(fileAsset.SizeBytes, result.SizeBytes);
        Assert.Equal(fileAsset.StoragePath, result.StoragePath);
        Assert.Equal(fileAsset.Id, repository.RequestedFileId);
        Assert.Equal(cancellationSource.Token, repository.RequestedCancellationToken);
    }

    [Fact]
    public async Task HandleAsync_WhenFileAssetDoesNotExist_ReturnsNull()
    {
        Guid fileId = Guid.NewGuid();
        var repository = new FakeFileAssetRepository(null);
        var handler = new GetFileAssetHandler(repository);

        GetFileAssetResult? result = await handler.HandleAsync(
            new GetFileAssetQuery(fileId),
            CancellationToken.None);

        Assert.Null(result);
        Assert.Equal(fileId, repository.RequestedFileId);
    }

    private sealed class FakeFileAssetRepository(FileAsset? fileAsset) : IFileAssetRepository
    {
        public Guid RequestedFileId { get; private set; }

        public CancellationToken RequestedCancellationToken { get; private set; }

        public Task<FileAsset?> GetByIdAsync(
            Guid fileId,
            CancellationToken cancellationToken)
        {
            RequestedFileId = fileId;
            RequestedCancellationToken = cancellationToken;
            return Task.FromResult(fileAsset);
        }

        public Task AddAsync(FileAsset fileAsset, CancellationToken cancellationToken)
        {
            throw new NotSupportedException();
        }

        public Task SaveChangesAsync(CancellationToken cancellationToken)
        {
            throw new NotSupportedException();
        }
    }
}
