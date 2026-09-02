using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using OpsPilot.Api.Features.Files.Contracts.Requests;
using OpsPilot.Api.Features.Files.Contracts.Responses;
using OpsPilot.Application.Exceptions;
using OpsPilot.Application.Files.Upload;

namespace OpsPilot.Api.Features.Files;

[ApiController]
[Route("api/files")]
[Authorize]
public sealed class FilesController(UploadFileHandler uploadFileHandler) : ControllerBase
{
    [HttpPost]
    [Consumes("multipart/form-data")]
    [ProducesResponseType(typeof(UploadFileResponse), StatusCodes.Status201Created)]
    public async Task<ActionResult<UploadFileResponse>> Upload(
        [FromForm] UploadFileRequest? request,
        CancellationToken cancellationToken)
    {
        IFormFile file = request?.File
            ?? throw new ApplicationValidationException("A file is required.");

        await using Stream content = file.OpenReadStream();
        var command = new UploadFileCommand(
            file.FileName,
            file.ContentType,
            file.Length,
            content);

        UploadFileResult result = await uploadFileHandler.HandleAsync(
            command,
            cancellationToken);

        var response = new UploadFileResponse(
            result.Id,
            result.FileName,
            result.ContentType,
            result.SizeBytes,
            result.CreatedAtUtc);

        return StatusCode(StatusCodes.Status201Created, response);
    }
}
