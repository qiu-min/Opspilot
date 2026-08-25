using Microsoft.Extensions.Logging;
using OpsPilot.Application.Abstractions.Files;

namespace OpsPilot.Infrastructure.Files;

public sealed class LocalFileStorage : IFileStorage
{
    private const string UploadsDirectory = "uploads";
    private readonly string rootPath;
    private readonly ILogger<LocalFileStorage> logger;

    public LocalFileStorage(
        FileStorageOptions options,
        ILogger<LocalFileStorage> logger)
    {
        if (string.IsNullOrWhiteSpace(options.RootPath))
        {
            throw new InvalidOperationException("File storage root path is not configured.");
        }

        rootPath = Path.GetFullPath(options.RootPath);
        this.logger = logger;
    }

    public async Task<StoredFile> SaveAsync(
        string originalFileName,
        Stream content,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(content);
        cancellationToken.ThrowIfCancellationRequested();

        string safeOriginalFileName = Path.GetFileName(originalFileName ?? string.Empty);
        string extension = Path.GetExtension(safeOriginalFileName);
        if (!string.Equals(extension, ".xlsx", StringComparison.OrdinalIgnoreCase))
        {
            throw new ArgumentException("Only .xlsx files can be stored.", nameof(originalFileName));
        }

        string storedFileName = $"{Guid.NewGuid():N}.xlsx";
        string storagePath = $"{UploadsDirectory}/{storedFileName}";
        string physicalPath = GetPhysicalPath(storagePath);

        Directory.CreateDirectory(Path.GetDirectoryName(physicalPath)!);

        try
        {
            await using var fileStream = new FileStream(
                physicalPath,
                FileMode.CreateNew,
                FileAccess.Write,
                FileShare.None,
                bufferSize: 81920,
                options: FileOptions.Asynchronous | FileOptions.SequentialScan);

            await content.CopyToAsync(fileStream, cancellationToken);
        }
        catch (Exception)
        {
            try
            {
                File.Delete(physicalPath);
            }
            catch (Exception cleanupException)
            {
                logger.LogError(
                    cleanupException,
                    "Failed to clean up partially stored file {StoragePath}.",
                    storagePath);
            }

            throw;
        }

        return new StoredFile(storedFileName, storagePath);
    }

    public Task DeleteAsync(string storagePath, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();

        string physicalPath = GetPhysicalPath(storagePath);
        if (File.Exists(physicalPath))
        {
            File.Delete(physicalPath);
        }

        return Task.CompletedTask;
    }

    private string GetPhysicalPath(string storagePath)
    {
        if (string.IsNullOrWhiteSpace(storagePath) || Path.IsPathRooted(storagePath))
        {
            throw new ArgumentException("Storage path must be a non-empty relative path.", nameof(storagePath));
        }

        string[] pathSegments = storagePath.Split(
            new[] { '/', '\\' },
            StringSplitOptions.RemoveEmptyEntries);
        if (pathSegments.Any(segment => segment is "." or ".."))
        {
            throw new ArgumentException("Storage path cannot contain traversal segments.", nameof(storagePath));
        }

        string normalizedRelativePath = storagePath.Replace('/', Path.DirectorySeparatorChar);
        string physicalPath = Path.GetFullPath(Path.Combine(rootPath, normalizedRelativePath));
        string rootWithSeparator = rootPath.EndsWith(
            Path.DirectorySeparatorChar.ToString(),
            StringComparison.Ordinal)
            ? rootPath
            : rootPath + Path.DirectorySeparatorChar;

        if (!physicalPath.StartsWith(rootWithSeparator, StringComparison.OrdinalIgnoreCase))
        {
            throw new ArgumentException("Storage path must remain inside the storage root.", nameof(storagePath));
        }

        return physicalPath;
    }
}
