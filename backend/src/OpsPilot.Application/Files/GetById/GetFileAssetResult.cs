namespace OpsPilot.Application.Files.GetById;

public sealed record GetFileAssetResult(
    Guid Id,
    string OriginalFileName,
    string ContentType,
    long SizeBytes,
    string StoragePath);
