namespace OpsPilot.Api.AnalysisTasks.Contracts;

public sealed record AnalysisTaskResponse(
    Guid Id,
    string Status,
    DateTime CreatedAtUtc);
