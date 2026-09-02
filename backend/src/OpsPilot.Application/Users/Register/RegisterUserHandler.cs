using OpsPilot.Application.Abstractions.Persistence;
using OpsPilot.Application.Abstractions.Security;
using OpsPilot.Application.Exceptions;
using OpsPilot.Domain.Users;

namespace OpsPilot.Application.Users.Register;

public sealed class RegisterUserHandler(
    IUserRepository userRepository,
    IPasswordHasher passwordHasher,
    TimeProvider timeProvider)
{
    public async Task<RegisterUserResult> HandleAsync(
        RegisterUserCommand command,
        CancellationToken cancellationToken)
    {
        string normalizedEmail = NormalizeEmail(command.Email);

        User? existingUser = await userRepository.GetByEmailAsync(
            normalizedEmail,
            cancellationToken);
        if (existingUser is not null)
        {
            throw new ApplicationConflictException(
                "A user with this email already exists.");
        }

        string password = ValidatePassword(command.Password);
        string passwordHash = passwordHasher.Hash(password);

        User user;
        try
        {
            user = User.Create(
                normalizedEmail,
                passwordHash,
                timeProvider.GetUtcNow().UtcDateTime);
        }
        catch (ArgumentException exception)
        {
            throw new ApplicationValidationException(exception.Message, exception);
        }

        await userRepository.AddAsync(user, cancellationToken);
        await userRepository.SaveChangesAsync(cancellationToken);

        return new RegisterUserResult(
            user.Id,
            user.Email,
            user.CreatedAtUtc);
    }

    private static string NormalizeEmail(string? email)
    {
        string normalizedEmail = email?.Trim().ToLowerInvariant() ?? string.Empty;
        if (string.IsNullOrWhiteSpace(normalizedEmail))
        {
            throw new ApplicationValidationException("Email cannot be empty.");
        }

        if (normalizedEmail.Length > User.MaxEmailLength)
        {
            throw new ApplicationValidationException(
                $"Email cannot exceed {User.MaxEmailLength} characters.");
        }

        return normalizedEmail;
    }

    private static string ValidatePassword(string? password)
    {
        if (string.IsNullOrWhiteSpace(password))
        {
            throw new ApplicationValidationException("Password cannot be empty.");
        }

        if (password.Length < RegisterUserLimits.MinPasswordLength)
        {
            throw new ApplicationValidationException(
                $"Password must be at least {RegisterUserLimits.MinPasswordLength} characters.");
        }

        if (password.Length > RegisterUserLimits.MaxPasswordLength)
        {
            throw new ApplicationValidationException(
                $"Password cannot exceed {RegisterUserLimits.MaxPasswordLength} characters.");
        }

        return password;
    }
}
