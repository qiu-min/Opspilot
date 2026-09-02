using System.Net.Mail;
using OpsPilot.Application.Abstractions.Persistence;
using OpsPilot.Application.Abstractions.Security;
using OpsPilot.Application.Exceptions;
using OpsPilot.Domain.Users;

namespace OpsPilot.Application.Users.Login;

public sealed class LoginUserHandler(
    IUserRepository userRepository,
    IPasswordHasher passwordHasher,
    IAccessTokenProvider accessTokenProvider)
{
    private const string InvalidCredentialsMessage = "Invalid email or password.";

    public async Task<LoginUserResult> HandleAsync(
        LoginUserCommand command,
        CancellationToken cancellationToken)
    {
        string normalizedEmail = NormalizeEmail(command.Email);
        string password = ValidatePassword(command.Password);

        User? user = await userRepository.GetByEmailAsync(
            normalizedEmail,
            cancellationToken);

        if (user is null || !passwordHasher.Verify(password, user.PasswordHash))
        {
            throw new ApplicationUnauthorizedException(InvalidCredentialsMessage);
        }

        AccessTokenResult accessToken = accessTokenProvider.Create(user);

        return new LoginUserResult(
            user.Id,
            user.Email,
            accessToken.Token,
            accessToken.ExpiresAtUtc);
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

        if (!IsValidEmailFormat(normalizedEmail))
        {
            throw new ApplicationValidationException("Email format is invalid.");
        }

        return normalizedEmail;
    }

    private static bool IsValidEmailFormat(string email)
    {
        int atSignIndex = email.IndexOf('@');
        if (atSignIndex <= 0 ||
            atSignIndex == email.Length - 1 ||
            atSignIndex != email.LastIndexOf('@'))
        {
            return false;
        }

        try
        {
            MailAddress parsedEmail = new(email);
            return string.Equals(
                parsedEmail.Address,
                email,
                StringComparison.OrdinalIgnoreCase);
        }
        catch (FormatException)
        {
            return false;
        }
    }

    private static string ValidatePassword(string? password)
    {
        if (string.IsNullOrWhiteSpace(password))
        {
            throw new ApplicationValidationException("Password cannot be empty.");
        }

        return password;
    }
}
