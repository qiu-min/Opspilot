namespace OpsPilot.Domain.Users;

public sealed class User
{
    public const int MaxEmailLength = 320;
    public const int MaxPasswordHashLength = 512;

    private User()
    {
        Email = string.Empty;
        PasswordHash = string.Empty;
    }

    private User(
        Guid id,
        string email,
        string passwordHash,
        DateTime createdAtUtc)
    {
        Id = id;
        Email = email;
        PasswordHash = passwordHash;
        CreatedAtUtc = createdAtUtc;
    }

    public Guid Id { get; private set; }

    public string Email { get; private set; }

    public string PasswordHash { get; private set; }

    public DateTime CreatedAtUtc { get; private set; }

    public static User Create(
        string email,
        string passwordHash,
        DateTime createdAtUtc)
    {
        string normalizedEmail = email?.Trim().ToLowerInvariant() ?? string.Empty;
        string normalizedPasswordHash = passwordHash?.Trim() ?? string.Empty;

        EnsureRequired(normalizedEmail, nameof(email));
        EnsureMaxLength(normalizedEmail, MaxEmailLength, nameof(email));
        EnsureRequired(normalizedPasswordHash, nameof(passwordHash));
        EnsureMaxLength(
            normalizedPasswordHash,
            MaxPasswordHashLength,
            nameof(passwordHash));

        return new User(
            Guid.NewGuid(),
            normalizedEmail,
            normalizedPasswordHash,
            createdAtUtc);
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
