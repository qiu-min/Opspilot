using OpsPilot.Application.Abstractions.Persistence;
using OpsPilot.Domain.AnalysisTasks;

namespace OpsPilot.Infrastructure.Persistence.Repositories;

public sealed class AnalysisTaskRepository(OpsPilotDbContext dbContext) : IAnalysisTaskRepository
{
    public async Task AddAsync(
        AnalysisTask analysisTask,
        CancellationToken cancellationToken)
    {
        await dbContext.AnalysisTasks.AddAsync(analysisTask, cancellationToken);
    }

    public Task SaveChangesAsync(CancellationToken cancellationToken)
    {
        return dbContext.SaveChangesAsync(cancellationToken);
    }
}
