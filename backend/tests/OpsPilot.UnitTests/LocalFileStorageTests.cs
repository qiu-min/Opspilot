using Microsoft.Extensions.Logging.Abstractions;
using OpsPilot.Application.Abstractions.Files;
using OpsPilot.Infrastructure.Files;

namespace OpsPilot.UnitTests;

public sealed class LocalFileStorageTests : IDisposable
{
    private readonly string rootPath = Path.Combine(
        Path.GetTempPath(),
        $"OpsPilot-local-storage-tests-{Guid.NewGuid():N}");
    private readonly LocalFileStorage storage;

    public LocalFileStorageTests()
    {
        storage = new LocalFileStorage(
            new FileStorageOptions { RootPath = rootPath },
            NullLogger<LocalFileStorage>.Instance);
    }

    [Fact]
    public async Task SaveAsync_SavesContentAndPreservesOriginalExtension()
    {
        byte[] contentBytes = [1, 2, 3];
        using var content = new MemoryStream(contentBytes);

        StoredFile storedFile = await storage.SaveAsync(
            "report.csv",
            content,
            CancellationToken.None);

        Assert.EndsWith(".csv", storedFile.StoredFileName, StringComparison.Ordinal);
        Assert.Equal($"uploads/{storedFile.StoredFileName}", storedFile.StoragePath);

        string physicalPath = GetPhysicalPath(storedFile.StoragePath);
        Assert.Equal(contentBytes, await File.ReadAllBytesAsync(physicalPath));
    }

    [Fact]
    public async Task SaveAsync_GeneratesUniqueStoredFileNames()
    {
        using var firstContent = new MemoryStream([1]);
        using var secondContent = new MemoryStream([2]);

        StoredFile first = await storage.SaveAsync(
            "report.xlsx",
            firstContent,
            CancellationToken.None);
        StoredFile second = await storage.SaveAsync(
            "report.xlsx",
            secondContent,
            CancellationToken.None);

        Assert.NotEqual(first.StoredFileName, second.StoredFileName);
        Assert.True(File.Exists(GetPhysicalPath(first.StoragePath)));
        Assert.True(File.Exists(GetPhysicalPath(second.StoragePath)));
    }

    [Fact]
    public async Task DeleteAsync_RejectsPathTraversal()
    {
        await Assert.ThrowsAsync<ArgumentException>(() => storage.DeleteAsync(
            "uploads/../outside.csv",
            CancellationToken.None));
    }

    [Fact]
    public async Task DeleteAsync_DeletesStoredFile()
    {
        using var content = new MemoryStream([1, 2]);
        StoredFile storedFile = await storage.SaveAsync(
            "report.csv",
            content,
            CancellationToken.None);
        string physicalPath = GetPhysicalPath(storedFile.StoragePath);

        await storage.DeleteAsync(storedFile.StoragePath, CancellationToken.None);

        Assert.False(File.Exists(physicalPath));
    }

    public void Dispose()
    {
        if (Directory.Exists(rootPath))
        {
            Directory.Delete(rootPath, recursive: true);
        }
    }

    private string GetPhysicalPath(string storagePath)
    {
        return Path.Combine(
            rootPath,
            storagePath.Replace('/', Path.DirectorySeparatorChar));
    }
}
