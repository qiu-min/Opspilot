using OpsPilot.Domain.Users;

namespace OpsPilot.UnitTests;

public sealed class UserTests
{
    private static readonly DateTime CreatedAtUtc =
        new(2026, 9, 2, 1, 0, 0, DateTimeKind.Utc);

    [Fact]
    public void Create_WithValidValuesCreatesUser()
    {
        User user = User.Create(
            "user@example.com",
            "hashed-password",
            CreatedAtUtc);

        Assert.NotEqual(Guid.Empty, user.Id);
        Assert.Equal("user@example.com", user.Email);
        Assert.Equal("hashed-password", user.PasswordHash);
        Assert.Equal(CreatedAtUtc, user.CreatedAtUtc);
    }

    [Fact]
    public void Create_NormalizesEmail()
    {
        User user = User.Create(
            "  USER@Example.COM  ",
            "hashed-password",
            CreatedAtUtc);

        Assert.Equal("user@example.com", user.Email);
    }

    [Theory]
    [InlineData("")]
    [InlineData("  ")]
    public void Create_WithEmptyEmailRejects(string email)
    {
        Assert.Throws<ArgumentException>(() => User.Create(
            email,
            "hashed-password",
            CreatedAtUtc));
    }

    [Theory]
    [InlineData("")]
    [InlineData("  ")]
    public void Create_WithEmptyPasswordHashRejects(string passwordHash)
    {
        Assert.Throws<ArgumentException>(() => User.Create(
            "user@example.com",
            passwordHash,
            CreatedAtUtc));
    }

    [Fact]
    public void Create_WithEmailLongerThanMaximumRejects()
    {
        string email = new string('a', User.MaxEmailLength - "@example.com".Length + 1)
            + "@example.com";

        Assert.Throws<ArgumentException>(() => User.Create(
            email,
            "hashed-password",
            CreatedAtUtc));
    }

    [Fact]
    public void Create_WithPasswordHashLongerThanMaximumRejects()
    {
        string passwordHash = new('h', User.MaxPasswordHashLength + 1);

        Assert.Throws<ArgumentException>(() => User.Create(
            "user@example.com",
            passwordHash,
            CreatedAtUtc));
    }
}
