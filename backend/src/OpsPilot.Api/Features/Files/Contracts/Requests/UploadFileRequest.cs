using Microsoft.AspNetCore.Http;

namespace OpsPilot.Api.Features.Files.Contracts.Requests;

public sealed class UploadFileRequest
{
    public IFormFile? File { get; init; }
}
