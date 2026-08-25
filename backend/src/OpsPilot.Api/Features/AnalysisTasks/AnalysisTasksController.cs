using Microsoft.AspNetCore.Mvc;
using OpsPilot.Application.AnalysisTasks.Create;
using OpsPilot.Api.AnalysisTasks.Contracts;

namespace OpsPilot.Api.AnalysisTasks;

[ApiController]
[Route("api/analysis-tasks")]
public sealed class AnalysisTasksController(
    CreateAnalysisTaskHandler createAnalysisTaskHandler) : ControllerBase
{
    [HttpPost]
    [ProducesResponseType(typeof(AnalysisTaskResponse), StatusCodes.Status201Created)]
    public async Task<ActionResult<AnalysisTaskResponse>> Create(
        CreateAnalysisTaskRequest request,
        CancellationToken cancellationToken)
    {
        var command = new CreateAnalysisTaskCommand(request.FileId, request.Prompt);
        CreateAnalysisTaskResult result = await createAnalysisTaskHandler.HandleAsync(
            command,
            cancellationToken);

        var response = new AnalysisTaskResponse(
            result.Id,
            result.Status.ToString(),
            result.CreatedAtUtc);

        return StatusCode(StatusCodes.Status201Created, response);
    }
}
