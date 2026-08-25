namespace OpsPilot.Application.Files.Upload;

public sealed record UploadFileCommand(
    string FileName,
    string ContentType,
    long Length,
    Stream Content);
