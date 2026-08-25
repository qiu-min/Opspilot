namespace OpsPilot.Api.AnalysisTasks;

public sealed record AnalysisTaskResponse(
    Guid Id,
    string Status,
    DateTime CreatedAtUtc);
