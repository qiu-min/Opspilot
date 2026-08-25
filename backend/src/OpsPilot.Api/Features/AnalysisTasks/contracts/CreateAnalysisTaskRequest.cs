namespace OpsPilot.Api.AnalysisTasks.Contracts;

public sealed record CreateAnalysisTaskRequest(
    Guid FileId,
    string Prompt);
