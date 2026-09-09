namespace OpsPilot.Domain.Sessions;

/// <summary>Backend ownership and product metadata for an Agent Service Session.</summary>
public sealed class Session
{
    public const int MaxTitleLength = 200;
    public const string DefaultTitle = "New session";

    private Session()
    {
        Title = string.Empty;
    }

    private Session(Guid id, Guid userId, string title, DateTime createdAtUtc)
    {
        Id = id;
        UserId = userId;
        Title = title;
        CreatedAtUtc = createdAtUtc;
        UpdatedAtUtc = createdAtUtc;
    }

    public Guid Id { get; private set; }
    public Guid UserId { get; private set; }
    public string Title { get; private set; }
    public DateTime CreatedAtUtc { get; private set; }
    public DateTime UpdatedAtUtc { get; private set; }

    public static Session Create(Guid id, Guid userId, string title, DateTime createdAtUtc)
    {
        if (id == Guid.Empty) throw new ArgumentException("Id cannot be empty.", nameof(id));
        if (userId == Guid.Empty) throw new ArgumentException("UserId cannot be empty.", nameof(userId));
        string normalizedTitle = title?.Trim() ?? string.Empty;
        if (string.IsNullOrWhiteSpace(normalizedTitle))
            throw new ArgumentException("Title cannot be empty.", nameof(title));
        if (normalizedTitle.Length > MaxTitleLength)
            throw new ArgumentException($"Title cannot exceed {MaxTitleLength} characters.", nameof(title));
        return new Session(id, userId, normalizedTitle, createdAtUtc);
    }

    /// <summary>Touches product metadata when a new Turn is confirmed started.</summary>
    public void Touch(DateTime updatedAtUtc)
    {
        if (updatedAtUtc < CreatedAtUtc)
            throw new ArgumentException("UpdatedAtUtc cannot precede CreatedAtUtc.", nameof(updatedAtUtc));
        UpdatedAtUtc = updatedAtUtc;
    }
}
