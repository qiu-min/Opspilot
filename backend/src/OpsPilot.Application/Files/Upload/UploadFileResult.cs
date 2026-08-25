namespace OpsPilot.Application.Files.Upload;

public sealed record UploadFileResult(
    Guid Id,
    string FileName,
    string ContentType,
    long SizeBytes,
    DateTime CreatedAtUtc);
