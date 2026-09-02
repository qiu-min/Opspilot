using OpsPilot.Application.Abstractions.Persistence;
using OpsPilot.Application.Abstractions.Security;
using OpsPilot.Application.Exceptions;
using OpsPilot.Application.Users.Login;
using OpsPilot.Domain.Users;

namespace OpsPilot.UnitTests;

public sealed class LoginUserHandlerTests
{
    [Fact]
    public async Task HandleAsync_WithValidCredentialsReturnsAccessTokenResult()
    {
        User user = User.Create(
            "user@example.com",
            "hashed-password",
            new DateTime(2026, 9, 2, 1, 0, 0, DateTimeKind.Utc));
        var repository = new FakeUserRepository { ExistingUser = user };
        var passwordHasher = new FakePasswordHasher { VerificationResult = true };
        var tokenProvider = new FakeAccessTokenProvider(
            new AccessTokenResult(
                "access-token",
                new DateTime(2026, 9, 2, 2, 0, 0, DateTimeKind.Utc)));
        var handler = new LoginUserHandler(repository, passwordHasher, tokenProvider);

        LoginUserResult result = await handler.HandleAsync(
            new LoginUserCommand("user@example.com", "password123"),
            CancellationToken.None);

        Assert.Equal(user.Id, result.UserId);
        Assert.Equal(user.Email, result.Email);
        Assert.Equal("access-token", result.AccessToken);
        Assert.Equal(new DateTime(2026, 9, 2, 2, 0, 0, DateTimeKind.Utc), result.ExpiresAtUtc);
        Assert.Equal("password123", passwordHasher.PasswordPassedToVerify);
        Assert.Equal(user.PasswordHash, passwordHasher.HashPassedToVerify);
        Assert.Same(user, tokenProvider.UserPassedToCreate);
        Assert.DoesNotContain(
            typeof(LoginUserResult).GetProperties(),
            property => property.Name == nameof(User.PasswordHash));
    }

    [Fact]
    public async Task HandleAsync_NormalizesEmailBeforeRepositoryLookup()
    {
        var repository = new FakeUserRepository();
        var handler = CreateHandler(repository, new FakePasswordHasher());

        await Assert.ThrowsAsync<ApplicationUnauthorizedException>(() => handler.HandleAsync(
            new LoginUserCommand("  USER@EXAMPLE.COM  ", "password123"),
            CancellationToken.None));

        Assert.Equal("user@example.com", repository.EmailPassedToGetByEmail);
    }

    [Fact]
    public async Task HandleAsync_WhenUserDoesNotExistThrowsGenericUnauthorizedException()
    {
        var repository = new FakeUserRepository();
        var passwordHasher = new FakePasswordHasher();
        var handler = CreateHandler(repository, passwordHasher);

        ApplicationUnauthorizedException exception = await Assert.ThrowsAsync<ApplicationUnauthorizedException>(
            () => handler.HandleAsync(
                new LoginUserCommand("user@example.com", "password123"),
                CancellationToken.None));

        Assert.Equal("Invalid email or password.", exception.Message);
        Assert.False(passwordHasher.VerifyWasCalled);
    }

    [Fact]
    public async Task HandleAsync_WhenPasswordIsIncorrectThrowsSameGenericUnauthorizedException()
    {
        var repository = new FakeUserRepository
        {
            ExistingUser = User.Create(
                "user@example.com",
                "hashed-password",
                DateTime.UtcNow)
        };
        var passwordHasher = new FakePasswordHasher { VerificationResult = false };
        var handler = CreateHandler(repository, passwordHasher);

        ApplicationUnauthorizedException exception = await Assert.ThrowsAsync<ApplicationUnauthorizedException>(
            () => handler.HandleAsync(
                new LoginUserCommand("user@example.com", "wrong-password"),
                CancellationToken.None));

        Assert.Equal("Invalid email or password.", exception.Message);
        Assert.True(passwordHasher.VerifyWasCalled);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("  ")]
    public async Task HandleAsync_WithBlankEmailThrowsValidation(string? email)
    {
        var repository = new FakeUserRepository();
        var handler = CreateHandler(repository, new FakePasswordHasher());

        ApplicationValidationException exception = await Assert.ThrowsAsync<ApplicationValidationException>(
            () => handler.HandleAsync(
                new LoginUserCommand(email, "password123"),
                CancellationToken.None));

        Assert.Equal("Email cannot be empty.", exception.Message);
        Assert.Null(repository.EmailPassedToGetByEmail);
    }

    [Fact]
    public async Task HandleAsync_WithInvalidEmailFormatThrowsValidation()
    {
        var repository = new FakeUserRepository();
        var handler = CreateHandler(repository, new FakePasswordHasher());

        ApplicationValidationException exception = await Assert.ThrowsAsync<ApplicationValidationException>(
            () => handler.HandleAsync(
                new LoginUserCommand("not-an-email", "password123"),
                CancellationToken.None));

        Assert.Equal("Email format is invalid.", exception.Message);
        Assert.Null(repository.EmailPassedToGetByEmail);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("  ")]
    public async Task HandleAsync_WithBlankPasswordThrowsValidation(string? password)
    {
        var repository = new FakeUserRepository();
        var handler = CreateHandler(repository, new FakePasswordHasher());

        ApplicationValidationException exception = await Assert.ThrowsAsync<ApplicationValidationException>(
            () => handler.HandleAsync(
                new LoginUserCommand("user@example.com", password),
                CancellationToken.None));

        Assert.Equal("Password cannot be empty.", exception.Message);
        Assert.Null(repository.EmailPassedToGetByEmail);
    }

    private static LoginUserHandler CreateHandler(
        FakeUserRepository repository,
        FakePasswordHasher passwordHasher)
    {
        return new LoginUserHandler(
            repository,
            passwordHasher,
            new FakeAccessTokenProvider(
                new AccessTokenResult(
                    "access-token",
                    DateTime.UtcNow.AddHours(1))));
    }

    private sealed class FakeUserRepository : IUserRepository
    {
        public User? ExistingUser { get; init; }

        public string? EmailPassedToGetByEmail { get; private set; }

        public Task<User?> GetByEmailAsync(string email, CancellationToken cancellationToken)
        {
            EmailPassedToGetByEmail = email;
            return Task.FromResult(ExistingUser);
        }

        public Task<User?> GetByIdAsync(Guid userId, CancellationToken cancellationToken) =>
            Task.FromResult<User?>(null);

        public Task AddAsync(User user, CancellationToken cancellationToken) =>
            Task.CompletedTask;

        public Task SaveChangesAsync(CancellationToken cancellationToken) =>
            Task.CompletedTask;
    }

    private sealed class FakePasswordHasher : IPasswordHasher
    {
        public bool VerificationResult { get; init; }

        public bool VerifyWasCalled { get; private set; }

        public string? PasswordPassedToVerify { get; private set; }

        public string? HashPassedToVerify { get; private set; }

        public string Hash(string password) => throw new NotSupportedException();

        public bool Verify(string password, string passwordHash)
        {
            VerifyWasCalled = true;
            PasswordPassedToVerify = password;
            HashPassedToVerify = passwordHash;
            return VerificationResult;
        }
    }

    private sealed class FakeAccessTokenProvider(AccessTokenResult result) : IAccessTokenProvider
    {
        public User? UserPassedToCreate { get; private set; }

        public AccessTokenResult Create(User user)
        {
            UserPassedToCreate = user;
            return result;
        }
    }
}
