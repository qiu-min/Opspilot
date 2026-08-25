namespace OpsPilot.Api.Features.AnalysisTasks.Contracts;

public sealed record AnalysisTaskResponse(
    Guid Id,
    string Status,
    DateTime CreatedAtUtc);
