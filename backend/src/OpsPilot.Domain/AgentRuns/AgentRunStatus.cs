namespace OpsPilot.Domain.AgentRuns;

public enum AgentRunStatus
{
    Pending = 0,
    Running = 1,
    Succeeded = 2,
    Failed = 3,
    Canceled = 4
}
