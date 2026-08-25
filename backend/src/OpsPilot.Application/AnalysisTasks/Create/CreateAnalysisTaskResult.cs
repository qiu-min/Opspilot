using OpsPilot.Domain.AnalysisTasks;

namespace OpsPilot.Application.AnalysisTasks.Create;

public sealed record CreateAnalysisTaskResult(
    Guid Id,
    AnalysisTaskStatus Status,
    DateTime CreatedAtUtc);
