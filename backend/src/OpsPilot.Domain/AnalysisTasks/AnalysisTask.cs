namespace OpsPilot.Domain.AnalysisTasks;

public sealed class AnalysisTask
{
    public const int MaxPromptLength = 4000;

    private AnalysisTask()
    {
        Prompt = string.Empty;
    }

    private AnalysisTask(Guid id, Guid fileId, string prompt, DateTime createdAtUtc)
    {
        Id = id;
        FileId = fileId;
        Prompt = prompt;
        Status = AnalysisTaskStatus.Pending;
        CreatedAtUtc = createdAtUtc;
        UpdatedAtUtc = createdAtUtc;
    }

    public Guid Id { get; private set; }

    public Guid FileId { get; private set; }

    public string Prompt { get; private set; }

    public AnalysisTaskStatus Status { get; private set; }

    public DateTime CreatedAtUtc { get; private set; }

    public DateTime UpdatedAtUtc { get; private set; }

    public DateTime? StartedAtUtc { get; private set; }

    public DateTime? CompletedAtUtc { get; private set; }

    public static AnalysisTask Create(Guid fileId, string prompt, DateTime createdAtUtc)
    {
        if (fileId == Guid.Empty)
        {
            throw new ArgumentException("FileId cannot be empty.", nameof(fileId));
        }

        string normalizedPrompt = prompt?.Trim() ?? string.Empty;
        if (string.IsNullOrWhiteSpace(normalizedPrompt))
        {
            throw new ArgumentException("Prompt cannot be empty.", nameof(prompt));
        }

        if (normalizedPrompt.Length > MaxPromptLength)
        {
            throw new ArgumentException(
                $"Prompt cannot exceed {MaxPromptLength} characters.",
                nameof(prompt));
        }

        return new AnalysisTask(Guid.NewGuid(), fileId, normalizedPrompt, createdAtUtc);
    }

    public void Start(DateTime startedAtUtc)
    {
        EnsureStatus(AnalysisTaskStatus.Pending, nameof(Start));

        Status = AnalysisTaskStatus.Running;
        StartedAtUtc = startedAtUtc;
        UpdatedAtUtc = startedAtUtc;
    }

    public void Complete(DateTime completedAtUtc)
    {
        EnsureStatus(AnalysisTaskStatus.Running, nameof(Complete));

        Status = AnalysisTaskStatus.Succeeded;
        CompletedAtUtc = completedAtUtc;
        UpdatedAtUtc = completedAtUtc;
    }

    public void Fail(DateTime completedAtUtc)
    {
        EnsureStatus(AnalysisTaskStatus.Pending, AnalysisTaskStatus.Running, nameof(Fail));

        Status = AnalysisTaskStatus.Failed;
        CompletedAtUtc = completedAtUtc;
        UpdatedAtUtc = completedAtUtc;
    }

    public void Cancel(DateTime completedAtUtc)
    {
        EnsureStatus(AnalysisTaskStatus.Pending, AnalysisTaskStatus.Running, nameof(Cancel));

        Status = AnalysisTaskStatus.Canceled;
        CompletedAtUtc = completedAtUtc;
        UpdatedAtUtc = completedAtUtc;
    }

    private void EnsureStatus(AnalysisTaskStatus expectedStatus, string operationName)
    {
        if (Status != expectedStatus)
        {
            throw new InvalidOperationException(
                $"Cannot {operationName.ToLowerInvariant()} an analysis task in {Status} status.");
        }
    }

    private void EnsureStatus(
        AnalysisTaskStatus firstExpectedStatus,
        AnalysisTaskStatus secondExpectedStatus,
        string operationName)
    {
        if (Status != firstExpectedStatus && Status != secondExpectedStatus)
        {
            throw new InvalidOperationException(
                $"Cannot {operationName.ToLowerInvariant()} an analysis task in {Status} status.");
        }
    }
}
