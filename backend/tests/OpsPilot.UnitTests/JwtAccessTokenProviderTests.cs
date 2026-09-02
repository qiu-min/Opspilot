using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using Microsoft.IdentityModel.Tokens;
using OpsPilot.Application.Abstractions.Security;
using OpsPilot.Domain.Users;
using OpsPilot.Infrastructure.Security;

namespace OpsPilot.UnitTests;

public sealed class JwtAccessTokenProviderTests
{
    private const string SigningKey =
        "unit-test-signing-key-for-opspilot-jwt-provider-2026-09-02";
    private static readonly DateTimeOffset CurrentTime =
        new(2026, 9, 2, 1, 0, 0, TimeSpan.Zero);

    [Fact]
    public void CreateIncludesExpectedClaimsAndMetadata()
    {
        var options = CreateOptions();
        var provider = new JwtAccessTokenProvider(options, new FixedTimeProvider(CurrentTime));
        User user = User.Create(
            "user@example.com",
            "hashed-password",
            CurrentTime.UtcDateTime);

        AccessTokenResult result = provider.Create(user);
        JwtSecurityToken token = new JwtSecurityTokenHandler().ReadJwtToken(result.Token);

        Assert.Equal(user.Id.ToString(), GetClaim(token, JwtRegisteredClaimNames.Sub));
        Assert.Equal(user.Email, GetClaim(token, JwtRegisteredClaimNames.Email));
        Assert.Equal(options.Issuer, token.Issuer);
        Assert.Contains(options.Audience, token.Audiences);
        Assert.Equal(CurrentTime.AddMinutes(options.AccessTokenLifetimeMinutes).UtcDateTime, result.ExpiresAtUtc);
        Assert.Equal(result.ExpiresAtUtc, token.ValidTo);
        Assert.DoesNotContain(token.Claims, claim => claim.Type is "role" or "permissions");
        Assert.DoesNotContain(token.Claims, claim => claim.Value.Contains("hashed-password", StringComparison.Ordinal));
    }

    [Fact]
    public void CreateProducesTokenWithVerifiableSignature()
    {
        var options = CreateOptions();
        var provider = new JwtAccessTokenProvider(options, new FixedTimeProvider(CurrentTime));
        User user = User.Create("user@example.com", "hashed-password", CurrentTime.UtcDateTime);
        AccessTokenResult result = provider.Create(user);

        var tokenHandler = new JwtSecurityTokenHandler { MapInboundClaims = false };
        ClaimsPrincipal principal = tokenHandler.ValidateToken(
            result.Token,
            new TokenValidationParameters
            {
                ValidateIssuer = true,
                ValidIssuer = options.Issuer,
                ValidateAudience = true,
                ValidAudience = options.Audience,
                ValidateIssuerSigningKey = true,
                IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(SigningKey)),
                ValidateLifetime = false,
            },
            out _);

        Assert.Equal(user.Id.ToString(), principal.FindFirstValue(JwtRegisteredClaimNames.Sub));
        Assert.Equal(user.Email, principal.FindFirstValue(JwtRegisteredClaimNames.Email));
    }

    [Fact]
    public void ValidateRejectsShortSigningKey()
    {
        JwtOptions options = new()
        {
            Issuer = "OpsPilot",
            Audience = "OpsPilot.Web",
            SigningKey = "too-short",
            AccessTokenLifetimeMinutes = 60,
        };

        InvalidOperationException exception = Assert.Throws<InvalidOperationException>(options.Validate);

        Assert.Contains("at least 32", exception.Message, StringComparison.Ordinal);
    }

    private static JwtOptions CreateOptions() =>
        new()
        {
            Issuer = "OpsPilot",
            Audience = "OpsPilot.Web",
            SigningKey = SigningKey,
            AccessTokenLifetimeMinutes = 60,
        };

    private static string GetClaim(JwtSecurityToken token, string claimType) =>
        token.Claims.Single(claim => claim.Type == claimType).Value;

    private sealed class FixedTimeProvider(DateTimeOffset currentTime) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => currentTime;
    }
}
