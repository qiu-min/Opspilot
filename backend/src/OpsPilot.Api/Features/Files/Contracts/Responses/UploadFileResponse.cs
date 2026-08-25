namespace OpsPilot.Api.Features.Files.Contracts.Responses;

public sealed record UploadFileResponse(
    Guid Id,
    string FileName,
    string ContentType,
    long SizeBytes,
    DateTime CreatedAtUtc);
