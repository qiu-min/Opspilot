using OpsPilot.Domain.AnalysisTasks;

namespace OpsPilot.Application.Abstractions.Persistence;

public interface IAnalysisTaskRepository
{
    Task AddAsync(
        AnalysisTask analysisTask,
        CancellationToken cancellationToken);

    Task SaveChangesAsync(CancellationToken cancellationToken);
}
