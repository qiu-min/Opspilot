using OpsPilot.Domain.AnalysisTasks;

namespace OpsPilot.Application.AnalysisTasks.CreateAnalysisTask;

public sealed record CreateAnalysisTaskResult(
    Guid Id,
    AnalysisTaskStatus Status,
    DateTime CreatedAtUtc);
