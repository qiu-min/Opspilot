namespace OpsPilot.Domain.Files;

public sealed class FileAsset
{
    public const int MaxOriginalFileNameLength = 255;
    public const int MaxStoredFileNameLength = 255;
    public const int MaxContentTypeLength = 255;
    public const int MaxStoragePathLength = 512;

    private FileAsset()
    {
        OriginalFileName = string.Empty;
        StoredFileName = string.Empty;
        ContentType = string.Empty;
        StoragePath = string.Empty;
    }

    private FileAsset(
        Guid id,
        Guid userId,
        string originalFileName,
        string storedFileName,
        string contentType,
        long sizeBytes,
        string storagePath,
        DateTime createdAtUtc)
    {
        Id = id;
        UserId = userId;
        OriginalFileName = originalFileName;
        StoredFileName = storedFileName;
        ContentType = contentType;
        SizeBytes = sizeBytes;
        StoragePath = storagePath;
        CreatedAtUtc = createdAtUtc;
    }

    public Guid Id { get; private set; }

    public Guid UserId { get; private set; }

    public string OriginalFileName { get; private set; }

    public string StoredFileName { get; private set; }

    public string ContentType { get; private set; }

    public long SizeBytes { get; private set; }

    public string StoragePath { get; private set; }

    public DateTime CreatedAtUtc { get; private set; }

    public static FileAsset Create(
        Guid userId,
        string originalFileName,
        string storedFileName,
        string contentType,
        long sizeBytes,
        string storagePath,
        DateTime createdAtUtc)
    {
        if (userId == Guid.Empty)
        {
            throw new ArgumentException("UserId cannot be empty.", nameof(userId));
        }

        string normalizedOriginalFileName = originalFileName?.Trim() ?? string.Empty;
        string normalizedStoredFileName = storedFileName?.Trim() ?? string.Empty;
        string normalizedContentType = contentType?.Trim() ?? string.Empty;
        string normalizedStoragePath = storagePath?.Trim() ?? string.Empty;

        EnsureRequired(normalizedOriginalFileName, nameof(originalFileName));
        EnsureRequired(normalizedStoredFileName, nameof(storedFileName));
        EnsureRequired(normalizedStoragePath, nameof(storagePath));

        EnsureMaxLength(
            normalizedOriginalFileName,
            MaxOriginalFileNameLength,
            nameof(originalFileName));
        EnsureMaxLength(
            normalizedStoredFileName,
            MaxStoredFileNameLength,
            nameof(storedFileName));
        EnsureMaxLength(normalizedContentType, MaxContentTypeLength, nameof(contentType));
        EnsureMaxLength(normalizedStoragePath, MaxStoragePathLength, nameof(storagePath));

        if (sizeBytes <= 0)
        {
            throw new ArgumentOutOfRangeException(
                nameof(sizeBytes),
                sizeBytes,
                "SizeBytes must be greater than zero.");
        }

        return new FileAsset(
            Guid.NewGuid(),
            userId,
            normalizedOriginalFileName,
            normalizedStoredFileName,
            normalizedContentType,
            sizeBytes,
            normalizedStoragePath,
            createdAtUtc);
    }

    private static void EnsureRequired(string value, string parameterName)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            throw new ArgumentException(
                $"{parameterName} cannot be empty.",
                parameterName);
        }
    }

    private static void EnsureMaxLength(string value, int maxLength, string parameterName)
    {
        if (value.Length > maxLength)
        {
            throw new ArgumentException(
                $"{parameterName} cannot exceed {maxLength} characters.",
                parameterName);
        }
    }
}
