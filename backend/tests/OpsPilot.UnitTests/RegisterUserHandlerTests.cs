using OpsPilot.Application.Abstractions.Persistence;
using OpsPilot.Application.Abstractions.Security;
using OpsPilot.Application.Exceptions;
using OpsPilot.Application.Users.Register;
using OpsPilot.Domain.Users;

namespace OpsPilot.UnitTests;

public sealed class RegisterUserHandlerTests
{
    private static readonly DateTimeOffset CurrentTime =
        new(2026, 9, 2, 1, 0, 0, TimeSpan.Zero);

    [Fact]
    public async Task HandleAsync_WithValidCommandPersistsUserAndReturnsPublicResult()
    {
        var repository = new FakeUserRepository();
        var hasher = new FakePasswordHasher("hashed-password");
        var handler = CreateHandler(repository, hasher);

        RegisterUserResult result = await handler.HandleAsync(
            new RegisterUserCommand("  USER@Example.COM  ", "password123"),
            CancellationToken.None);

        Assert.NotNull(repository.AddedUser);
        Assert.Equal("user@example.com", repository.AddedUser!.Email);
        Assert.Equal("hashed-password", repository.AddedUser.PasswordHash);
        Assert.Equal(CurrentTime.UtcDateTime, repository.AddedUser.CreatedAtUtc);
        Assert.Equal(repository.AddedUser.Id, result.Id);
        Assert.Equal("user@example.com", result.Email);
        Assert.Equal(CurrentTime.UtcDateTime, result.CreatedAtUtc);
        Assert.Equal("password123", hasher.PasswordPassedToHash);
        Assert.True(repository.WasSaved);
        Assert.DoesNotContain(
            typeof(RegisterUserResult).GetProperties(),
            property => property.Name == nameof(User.PasswordHash));
    }

    [Fact]
    public async Task HandleAsync_WhenEmailAlreadyExistsThrowsConflictWithoutHashing()
    {
        var repository = new FakeUserRepository
        {
            ExistingUser = User.Create(
                "user@example.com",
                "existing-hash",
                CurrentTime.UtcDateTime)
        };
        var hasher = new FakePasswordHasher("hashed-password");
        var handler = CreateHandler(repository, hasher);

        ApplicationConflictException exception = await Assert.ThrowsAsync<ApplicationConflictException>(
            () => handler.HandleAsync(
                new RegisterUserCommand(" USER@EXAMPLE.COM ", "password123"),
                CancellationToken.None));

        Assert.Contains("already exists", exception.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Null(hasher.PasswordPassedToHash);
        Assert.Null(repository.AddedUser);
        Assert.False(repository.WasSaved);
    }

    [Fact]
    public async Task HandleAsync_WhenPasswordIsTooShortThrowsValidationWithoutHashing()
    {
        var repository = new FakeUserRepository();
        var hasher = new FakePasswordHasher("hashed-password");
        var handler = CreateHandler(repository, hasher);

        await Assert.ThrowsAsync<ApplicationValidationException>(() => handler.HandleAsync(
            new RegisterUserCommand("user@example.com", "short"),
            CancellationToken.None));

        Assert.Null(hasher.PasswordPassedToHash);
        Assert.Null(repository.AddedUser);
        Assert.False(repository.WasSaved);
    }

    [Fact]
    public async Task HandleAsync_PropagatesCancellationTokenToRepository()
    {
        var repository = new FakeUserRepository();
        var handler = CreateHandler(repository, new FakePasswordHasher("hashed-password"));
        using var cancellationSource = new CancellationTokenSource();

        await handler.HandleAsync(
            new RegisterUserCommand("user@example.com", "password123"),
            cancellationSource.Token);

        Assert.Equal(cancellationSource.Token, repository.GetByEmailToken);
        Assert.Equal(cancellationSource.Token, repository.AddToken);
        Assert.Equal(cancellationSource.Token, repository.SaveToken);
    }

    private static RegisterUserHandler CreateHandler(
        FakeUserRepository repository,
        FakePasswordHasher hasher)
    {
        return new RegisterUserHandler(
            repository,
            hasher,
            new FixedTimeProvider(CurrentTime));
    }

    private sealed class FixedTimeProvider(DateTimeOffset currentTime) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => currentTime;
    }

    private sealed class FakeUserRepository : IUserRepository
    {
        public User? ExistingUser { get; init; }

        public User? AddedUser { get; private set; }

        public CancellationToken GetByEmailToken { get; private set; }

        public CancellationToken AddToken { get; private set; }

        public CancellationToken SaveToken { get; private set; }

        public bool WasSaved { get; private set; }

        public Task<User?> GetByEmailAsync(
            string email,
            CancellationToken cancellationToken)
        {
            GetByEmailToken = cancellationToken;
            return Task.FromResult(ExistingUser);
        }

        public Task<User?> GetByIdAsync(
            Guid userId,
            CancellationToken cancellationToken)
        {
            return Task.FromResult<User?>(null);
        }

        public Task AddAsync(User user, CancellationToken cancellationToken)
        {
            AddedUser = user;
            AddToken = cancellationToken;
            return Task.CompletedTask;
        }

        public Task SaveChangesAsync(CancellationToken cancellationToken)
        {
            SaveToken = cancellationToken;
            WasSaved = true;
            return Task.CompletedTask;
        }
    }

    private sealed class FakePasswordHasher(string hash) : IPasswordHasher
    {
        public string? PasswordPassedToHash { get; private set; }

        public string Hash(string password)
        {
            PasswordPassedToHash = password;
            return hash;
        }

        public bool Verify(string password, string passwordHash)
        {
            throw new NotSupportedException();
        }
    }
}
