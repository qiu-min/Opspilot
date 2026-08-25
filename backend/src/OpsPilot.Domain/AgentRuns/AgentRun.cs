namespace OpsPilot.Domain.AgentRuns;

public sealed class AgentRun
{
    private AgentRun()
    {
    }

    private AgentRun(Guid id, Guid analysisTaskId, DateTime createdAtUtc)
    {
        Id = id;
        AnalysisTaskId = analysisTaskId;
        Status = AgentRunStatus.Pending;
        CreatedAtUtc = createdAtUtc;
        UpdatedAtUtc = createdAtUtc;
    }

    public Guid Id { get; private set; }

    public Guid AnalysisTaskId { get; private set; }

    public string? ExternalRunId { get; private set; }

    public AgentRunStatus Status { get; private set; }

    public DateTime CreatedAtUtc { get; private set; }

    public DateTime UpdatedAtUtc { get; private set; }

    public DateTime? StartedAtUtc { get; private set; }

    public DateTime? CompletedAtUtc { get; private set; }

    public static AgentRun Create(Guid analysisTaskId, DateTime createdAtUtc)
    {
        if (analysisTaskId == Guid.Empty)
        {
            throw new ArgumentException("AnalysisTaskId cannot be empty.", nameof(analysisTaskId));
        }

        return new AgentRun(Guid.NewGuid(), analysisTaskId, createdAtUtc);
    }

    public void Start(DateTime startedAtUtc)
    {
        EnsureStatus(AgentRunStatus.Pending, nameof(Start));

        Status = AgentRunStatus.Running;
        StartedAtUtc = startedAtUtc;
        UpdatedAtUtc = startedAtUtc;
    }

    public void Complete(DateTime completedAtUtc)
    {
        EnsureStatus(AgentRunStatus.Running, nameof(Complete));

        Status = AgentRunStatus.Succeeded;
        CompletedAtUtc = completedAtUtc;
        UpdatedAtUtc = completedAtUtc;
    }

    public void Fail(DateTime completedAtUtc)
    {
        EnsureStatus(AgentRunStatus.Pending, AgentRunStatus.Running, nameof(Fail));

        Status = AgentRunStatus.Failed;
        CompletedAtUtc = completedAtUtc;
        UpdatedAtUtc = completedAtUtc;
    }

    public void Cancel(DateTime completedAtUtc)
    {
        EnsureStatus(AgentRunStatus.Pending, AgentRunStatus.Running, nameof(Cancel));

        Status = AgentRunStatus.Canceled;
        CompletedAtUtc = completedAtUtc;
        UpdatedAtUtc = completedAtUtc;
    }

    private void EnsureStatus(AgentRunStatus expectedStatus, string operationName)
    {
        if (Status != expectedStatus)
        {
            throw new InvalidOperationException(
                $"Cannot {operationName.ToLowerInvariant()} an agent run in {Status} status.");
        }
    }

    private void EnsureStatus(
        AgentRunStatus firstExpectedStatus,
        AgentRunStatus secondExpectedStatus,
        string operationName)
    {
        if (Status != firstExpectedStatus && Status != secondExpectedStatus)
        {
            throw new InvalidOperationException(
                $"Cannot {operationName.ToLowerInvariant()} an agent run in {Status} status.");
        }
    }
}
