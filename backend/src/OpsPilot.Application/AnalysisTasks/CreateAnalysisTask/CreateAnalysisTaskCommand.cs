namespace OpsPilot.Application.AnalysisTasks.CreateAnalysisTask;

public sealed record CreateAnalysisTaskCommand(
    Guid FileId,
    string Prompt);
