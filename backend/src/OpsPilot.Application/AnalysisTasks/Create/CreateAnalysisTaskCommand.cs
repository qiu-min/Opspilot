namespace OpsPilot.Application.AnalysisTasks.Create;

public sealed record CreateAnalysisTaskCommand(
    Guid FileId,
    string Prompt);
