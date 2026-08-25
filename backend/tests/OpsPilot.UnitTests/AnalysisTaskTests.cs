using OpsPilot.Domain.AnalysisTasks;

namespace OpsPilot.UnitTests;

public sealed class AnalysisTaskTests
{
    private static readonly DateTime CreatedAtUtc =
        new(2026, 8, 25, 0, 0, 0, DateTimeKind.Utc);

    [Fact]
    public void Create_SetsPendingStatus()
    {
        AnalysisTask analysisTask = AnalysisTask.Create(
            Guid.NewGuid(),
            "Summarize this file",
            CreatedAtUtc);

        Assert.NotEqual(Guid.Empty, analysisTask.Id);
        Assert.Equal(AnalysisTaskStatus.Pending, analysisTask.Status);
        Assert.Equal(CreatedAtUtc, analysisTask.CreatedAtUtc);
        Assert.Equal(CreatedAtUtc, analysisTask.UpdatedAtUtc);
    }

    [Fact]
    public void Start_ChangesPendingToRunning()
    {
        AnalysisTask analysisTask = CreateAnalysisTask();
        DateTime startedAtUtc = CreatedAtUtc.AddMinutes(1);

        analysisTask.Start(startedAtUtc);

        Assert.Equal(AnalysisTaskStatus.Running, analysisTask.Status);
        Assert.Equal(startedAtUtc, analysisTask.StartedAtUtc);
        Assert.Equal(startedAtUtc, analysisTask.UpdatedAtUtc);
    }

    [Fact]
    public void Complete_ChangesRunningToSucceeded()
    {
        AnalysisTask analysisTask = CreateAnalysisTask();
        analysisTask.Start(CreatedAtUtc.AddMinutes(1));
        DateTime completedAtUtc = CreatedAtUtc.AddMinutes(2);

        analysisTask.Complete(completedAtUtc);

        Assert.Equal(AnalysisTaskStatus.Succeeded, analysisTask.Status);
        Assert.Equal(completedAtUtc, analysisTask.CompletedAtUtc);
        Assert.Equal(completedAtUtc, analysisTask.UpdatedAtUtc);
    }

    [Fact]
    public void Complete_FromPendingIsRejected()
    {
        AnalysisTask analysisTask = CreateAnalysisTask();

        Assert.Throws<InvalidOperationException>(
            () => analysisTask.Complete(CreatedAtUtc.AddMinutes(1)));
    }

    [Fact]
    public void Start_FromSucceededIsRejected()
    {
        AnalysisTask analysisTask = CreateAnalysisTask();
        analysisTask.Start(CreatedAtUtc.AddMinutes(1));
        analysisTask.Complete(CreatedAtUtc.AddMinutes(2));

        Assert.Throws<InvalidOperationException>(
            () => analysisTask.Start(CreatedAtUtc.AddMinutes(3)));
    }

    [Fact]
    public void Create_WithBlankPromptIsRejected()
    {
        Assert.Throws<ArgumentException>(
            () => AnalysisTask.Create(Guid.NewGuid(), "  ", CreatedAtUtc));
    }

    [Fact]
    public void Create_WithEmptyFileIdIsRejected()
    {
        Assert.Throws<ArgumentException>(
            () => AnalysisTask.Create(Guid.Empty, "Summarize this file", CreatedAtUtc));
    }

    private static AnalysisTask CreateAnalysisTask()
    {
        return AnalysisTask.Create(Guid.NewGuid(), "Summarize this file", CreatedAtUtc);
    }
}
