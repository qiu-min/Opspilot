using OpsPilot.Application.Abstractions.Persistence;
using OpsPilot.Application.Exceptions;
using OpsPilot.Domain.AnalysisTasks;

namespace OpsPilot.Application.AnalysisTasks.CreateAnalysisTask;

public sealed class CreateAnalysisTaskHandler(
    IAnalysisTaskRepository analysisTaskRepository,
    TimeProvider timeProvider)
{
    public async Task<CreateAnalysisTaskResult> HandleAsync(
        CreateAnalysisTaskCommand command,
        CancellationToken cancellationToken)
    {
        AnalysisTask analysisTask;
        try
        {
            DateTime createdAtUtc = timeProvider.GetUtcNow().UtcDateTime;
            analysisTask = AnalysisTask.Create(command.FileId, command.Prompt, createdAtUtc);
        }
        catch (ArgumentException exception)
        {
            throw new ApplicationValidationException(exception.Message, exception);
        }

        await analysisTaskRepository.AddAsync(analysisTask, cancellationToken);
        await analysisTaskRepository.SaveChangesAsync(cancellationToken);

        return new CreateAnalysisTaskResult(
            analysisTask.Id,
            analysisTask.Status,
            analysisTask.CreatedAtUtc);
    }
}
