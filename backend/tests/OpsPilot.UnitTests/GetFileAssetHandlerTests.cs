using OpsPilot.Application.Abstractions.Persistence;
using OpsPilot.Application.Abstractions.Security;
using OpsPilot.Application.Exceptions;
using OpsPilot.Application.Files.GetById;
using OpsPilot.Domain.Files;

namespace OpsPilot.UnitTests;

public sealed class GetFileAssetHandlerTests
{
    private static readonly Guid CurrentUserId =
        Guid.Parse("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");

    [Fact]
    public async Task HandleAsync_WhenFileAssetExists_MapsRepositoryEntityToResult()
    {
        DateTime createdAtUtc = new(2026, 8, 25, 12, 0, 0, DateTimeKind.Utc);
        FileAsset fileAsset = FileAsset.Create(
            CurrentUserId,
            "report.xlsx",
            "stored-report.xlsx",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            1234,
            "uploads/stored-report.xlsx",
            createdAtUtc);
        using var cancellationSource = new CancellationTokenSource();
        var repository = new FakeFileAssetRepository(fileAsset);
        var handler = new GetFileAssetHandler(repository, new FakeCurrentUser(CurrentUserId));

        GetFileAssetResult result = await handler.HandleAsync(
            new GetFileAssetQuery(fileAsset.Id),
            cancellationSource.Token);

        Assert.Equal(fileAsset.Id, result.Id);
        Assert.Equal(fileAsset.OriginalFileName, result.OriginalFileName);
        Assert.Equal(fileAsset.ContentType, result.ContentType);
        Assert.Equal(fileAsset.SizeBytes, result.SizeBytes);
        Assert.Equal(fileAsset.StoragePath, result.StoragePath);
        Assert.Equal(fileAsset.Id, repository.RequestedFileId);
        Assert.Equal(CurrentUserId, repository.RequestedUserId);
        Assert.Equal(cancellationSource.Token, repository.RequestedCancellationToken);
    }

    [Fact]
    public async Task HandleAsync_WhenFileAssetDoesNotExist_ThrowsNotFoundException()
    {
        Guid fileId = Guid.NewGuid();
        var repository = new FakeFileAssetRepository(null);
        var handler = new GetFileAssetHandler(repository, new FakeCurrentUser(CurrentUserId));

        await Assert.ThrowsAsync<ApplicationNotFoundException>(() => handler.HandleAsync(
            new GetFileAssetQuery(fileId),
            CancellationToken.None));

        Assert.Equal(fileId, repository.RequestedFileId);
        Assert.Equal(CurrentUserId, repository.RequestedUserId);
    }

    private sealed class FakeFileAssetRepository(FileAsset? fileAsset) : IFileAssetRepository
    {
        public Guid RequestedFileId { get; private set; }

        public CancellationToken RequestedCancellationToken { get; private set; }

        public Guid RequestedUserId { get; private set; }

        public Task<FileAsset?> GetByIdAndUserIdAsync(
            Guid fileId,
            Guid userId,
            CancellationToken cancellationToken)
        {
            RequestedFileId = fileId;
            RequestedUserId = userId;
            RequestedCancellationToken = cancellationToken;
            return Task.FromResult(fileAsset?.Id == fileId && fileAsset.UserId == userId
                ? fileAsset
                : null);
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

    private sealed class FakeCurrentUser(Guid userId) : ICurrentUser
    {
        public Guid UserId { get; } = userId;
    }
}
