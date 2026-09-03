using Microsoft.Extensions.Logging.Abstractions;
using OpsPilot.Application.Abstractions.Files;
using OpsPilot.Application.Abstractions.Persistence;
using OpsPilot.Application.Abstractions.Security;
using OpsPilot.Application.Exceptions;
using OpsPilot.Application.Files.Upload;
using OpsPilot.Domain.Files;

namespace OpsPilot.UnitTests;

public sealed class UploadFileHandlerTests
{
    private static readonly Guid CurrentUserId =
        Guid.Parse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");

    private static readonly DateTimeOffset CurrentTime =
        new(2026, 8, 25, 12, 0, 0, TimeSpan.Zero);

    [Fact]
    public async Task HandleAsync_WithValidXlsx_SavesFileAndPersistsAsset()
    {
        var storage = new FakeFileStorage();
        var repository = new FakeFileAssetRepository();
        var handler = CreateHandler(storage, repository);
        using var content = new MemoryStream([1, 2, 3]);

        UploadFileResult result = await handler.HandleAsync(
            new UploadFileCommand(
                "report.XLSX",
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                content.Length,
                content),
            CancellationToken.None);

        Assert.True(storage.WasSaved);
        Assert.NotNull(repository.AddedFileAsset);
        Assert.Equal(CurrentUserId, repository.AddedFileAsset!.UserId);
        Assert.Equal("report.XLSX", repository.AddedFileAsset!.OriginalFileName);
        Assert.Equal(content.Length, result.SizeBytes);
        Assert.Equal(CurrentTime.UtcDateTime, result.CreatedAtUtc);
        Assert.Null(storage.DeletedStoragePath);
    }

    [Fact]
    public async Task HandleAsync_WithEmptyFile_RejectsBeforeStorage()
    {
        var storage = new FakeFileStorage();
        var repository = new FakeFileAssetRepository();
        var handler = CreateHandler(storage, repository);
        using var content = new MemoryStream();

        await Assert.ThrowsAsync<ApplicationValidationException>(() => handler.HandleAsync(
            new UploadFileCommand("report.xlsx", "application/octet-stream", 0, content),
            CancellationToken.None));

        Assert.False(storage.WasSaved);
        Assert.Null(repository.AddedFileAsset);
    }

    [Fact]
    public async Task HandleAsync_WithNonXlsxFile_RejectsBeforeStorage()
    {
        var storage = new FakeFileStorage();
        var repository = new FakeFileAssetRepository();
        var handler = CreateHandler(storage, repository);
        using var content = new MemoryStream([1]);

        await Assert.ThrowsAsync<ApplicationValidationException>(() => handler.HandleAsync(
            new UploadFileCommand("report.csv", "text/csv", 1, content),
            CancellationToken.None));

        Assert.False(storage.WasSaved);
        Assert.Null(repository.AddedFileAsset);
    }

    [Fact]
    public async Task HandleAsync_WithFileLargerThanLimit_RejectsBeforeStorage()
    {
        var storage = new FakeFileStorage();
        var repository = new FakeFileAssetRepository();
        var handler = CreateHandler(storage, repository);
        using var content = new MemoryStream([1]);

        await Assert.ThrowsAsync<ApplicationValidationException>(() => handler.HandleAsync(
            new UploadFileCommand(
                "large.xlsx",
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                UploadFileLimits.MaxFileSizeBytes + 1,
                content),
            CancellationToken.None));

        Assert.False(storage.WasSaved);
        Assert.Null(repository.AddedFileAsset);
    }

    [Fact]
    public async Task HandleAsync_WhenDatabaseSaveFails_DeletesStoredFileAndRethrows()
    {
        var storage = new FakeFileStorage();
        var repository = new FakeFileAssetRepository
        {
            SaveException = new InvalidOperationException("database unavailable")
        };
        var handler = CreateHandler(storage, repository);
        using var content = new MemoryStream([1, 2]);

        InvalidOperationException exception = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            handler.HandleAsync(
                new UploadFileCommand("report.xlsx", "application/octet-stream", 2, content),
                CancellationToken.None));

        Assert.Equal("database unavailable", exception.Message);
        Assert.Equal("uploads/server-file.xlsx", storage.DeletedStoragePath);
    }

    private static UploadFileHandler CreateHandler(
        FakeFileStorage storage,
        FakeFileAssetRepository repository)
    {
        return new UploadFileHandler(
            storage,
            repository,
            new FakeCurrentUser(CurrentUserId),
            new FixedTimeProvider(CurrentTime),
            NullLogger<UploadFileHandler>.Instance);
    }

    private sealed class FixedTimeProvider(DateTimeOffset currentTime) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => currentTime;
    }

    private sealed class FakeFileStorage : IFileStorage
    {
        public bool WasSaved { get; private set; }

        public string? DeletedStoragePath { get; private set; }

        public Task<StoredFile> SaveAsync(
            string originalFileName,
            Stream content,
            CancellationToken cancellationToken)
        {
            WasSaved = true;
            return Task.FromResult(new StoredFile("server-file.xlsx", "uploads/server-file.xlsx"));
        }

        public Task DeleteAsync(string storagePath, CancellationToken cancellationToken)
        {
            DeletedStoragePath = storagePath;
            return Task.CompletedTask;
        }
    }

    private sealed class FakeFileAssetRepository : IFileAssetRepository
    {
        public FileAsset? AddedFileAsset { get; private set; }

        public Exception? SaveException { get; init; }

        public Task<FileAsset?> GetByIdAndUserIdAsync(
            Guid fileId,
            Guid userId,
            CancellationToken cancellationToken)
        {
            return Task.FromResult<FileAsset?>(null);
        }

        public Task AddAsync(FileAsset fileAsset, CancellationToken cancellationToken)
        {
            AddedFileAsset = fileAsset;
            return Task.CompletedTask;
        }

        public Task SaveChangesAsync(CancellationToken cancellationToken)
        {
            if (SaveException is not null)
            {
                throw SaveException;
            }

            return Task.CompletedTask;
        }
    }

    private sealed class FakeCurrentUser(Guid userId) : ICurrentUser
    {
        public Guid UserId { get; } = userId;
    }
}
