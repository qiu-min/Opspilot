namespace OpsPilot.Api.Features.AnalysisTasks.Contracts;

public sealed record CreateAnalysisTaskRequest(
    Guid FileId,
    string Prompt);
