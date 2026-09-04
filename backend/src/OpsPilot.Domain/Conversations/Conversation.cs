namespace OpsPilot.Domain.Conversations;

public sealed class Conversation
{
    public const int MaxTitleLength = 200;
    public const string DefaultTitle = "New conversation";

    private Conversation()
    {
        Title = string.Empty;
    }

    private Conversation(
        Guid id,
        Guid userId,
        string title,
        DateTime createdAtUtc)
    {
        Id = id;
        UserId = userId;
        AgentSessionId = null;
        Title = title;
        CreatedAtUtc = createdAtUtc;
        UpdatedAtUtc = createdAtUtc;
    }

    public Guid Id { get; private set; }

    public Guid UserId { get; private set; }

    public Guid? AgentSessionId { get; private set; }

    public string Title { get; private set; }

    public DateTime CreatedAtUtc { get; private set; }

    public DateTime UpdatedAtUtc { get; private set; }

    public static Conversation Create(
        Guid userId,
        string title,
        DateTime createdAtUtc)
    {
        if (userId == Guid.Empty)
        {
            throw new ArgumentException("UserId cannot be empty.", nameof(userId));
        }

        string normalizedTitle = title?.Trim() ?? string.Empty;
        EnsureRequired(normalizedTitle, nameof(title));
        EnsureMaxLength(normalizedTitle, MaxTitleLength, nameof(title));

        return new Conversation(
            Guid.NewGuid(),
            userId,
            normalizedTitle,
            createdAtUtc);
    }

    public void BindAgentSession(Guid agentSessionId, DateTime updatedAtUtc)
    {
        if (agentSessionId == Guid.Empty)
        {
            throw new ArgumentException(
                "AgentSessionId cannot be empty.",
                nameof(agentSessionId));
        }

        if (AgentSessionId is Guid existingAgentSessionId &&
            existingAgentSessionId != agentSessionId)
        {
            throw new InvalidOperationException(
                "Conversation is already bound to a different agent session.");
        }

        AgentSessionId = agentSessionId;
        UpdatedAtUtc = updatedAtUtc;
    }

    private static void EnsureRequired(string value, string parameterName)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            throw new ArgumentException(
                $"{parameterName} cannot be empty.",
                parameterName);
        }
    }

    private static void EnsureMaxLength(string value, int maxLength, string parameterName)
    {
        if (value.Length > maxLength)
        {
            throw new ArgumentException(
                $"{parameterName} cannot exceed {maxLength} characters.",
                parameterName);
        }
    }
}
