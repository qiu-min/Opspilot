using OpsPilot.Domain.AgentRuns;

namespace OpsPilot.UnitTests;

public sealed class AgentRunTests
{
    private static readonly DateTime CreatedAtUtc =
        new(2026, 8, 25, 0, 0, 0, DateTimeKind.Utc);

    [Fact]
    public void Create_SetsPendingStatus()
    {
        AgentRun agentRun = AgentRun.Create(Guid.NewGuid(), CreatedAtUtc);

        Assert.NotEqual(Guid.Empty, agentRun.Id);
        Assert.Equal(AgentRunStatus.Pending, agentRun.Status);
        Assert.Null(agentRun.ExternalRunId);
    }

    [Fact]
    public void Create_WithEmptyAnalysisTaskIdIsRejected()
    {
        Assert.Throws<ArgumentException>(
            () => AgentRun.Create(Guid.Empty, CreatedAtUtc));
    }

    [Fact]
    public void Start_ChangesPendingToRunning()
    {
        AgentRun agentRun = AgentRun.Create(Guid.NewGuid(), CreatedAtUtc);

        agentRun.Start(CreatedAtUtc.AddMinutes(1));

        Assert.Equal(AgentRunStatus.Running, agentRun.Status);
    }

    [Fact]
    public void Complete_FromPendingIsRejected()
    {
        AgentRun agentRun = AgentRun.Create(Guid.NewGuid(), CreatedAtUtc);

        Assert.Throws<InvalidOperationException>(
            () => agentRun.Complete(CreatedAtUtc.AddMinutes(1)));
    }
}
