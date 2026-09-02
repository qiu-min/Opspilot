using OpsPilot.Infrastructure.Security;

namespace OpsPilot.UnitTests;

public sealed class AspNetCorePasswordHasherTests
{
    [Fact]
    public void HashCreatesVerifiableHashWithoutStoringPlaintext()
    {
        const string password = "password123";
        var hasher = new AspNetCorePasswordHasher();

        string passwordHash = hasher.Hash(password);

        Assert.NotEqual(password, passwordHash);
        Assert.True(hasher.Verify(password, passwordHash));
        Assert.False(hasher.Verify("different-password", passwordHash));
    }
}
