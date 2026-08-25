namespace OpsPilot.Api.AnalysisTasks;

public sealed record CreateAnalysisTaskRequest(
    Guid FileId,
    string Prompt);
