using Microsoft.AspNetCore.Identity;
using OpsPilot.Application.Abstractions.Security;

namespace OpsPilot.Infrastructure.Security;

public sealed class AspNetCorePasswordHasher : IPasswordHasher
{
    private static readonly object HasherUser = new();
    private readonly PasswordHasher<object> passwordHasher = new();

    public string Hash(string password)
    {
        return passwordHasher.HashPassword(HasherUser, password);
    }

    public bool Verify(string password, string passwordHash)
    {
        PasswordVerificationResult result = passwordHasher.VerifyHashedPassword(
            HasherUser,
            passwordHash,
            password);

        return result != PasswordVerificationResult.Failed;
    }
}
