using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using Microsoft.IdentityModel.Tokens;
using OpsPilot.Application.Abstractions.Security;
using OpsPilot.Domain.Users;

namespace OpsPilot.Infrastructure.Security;

public sealed class JwtAccessTokenProvider : IAccessTokenProvider
{
    private readonly JwtOptions options;
    private readonly TimeProvider timeProvider;
    private readonly SigningCredentials signingCredentials;
    private readonly JwtSecurityTokenHandler tokenHandler = new();

    public JwtAccessTokenProvider(
        JwtOptions options,
        TimeProvider timeProvider)
    {
        options.Validate();
        this.options = options;
        this.timeProvider = timeProvider;

        SymmetricSecurityKey signingKey = new(Encoding.UTF8.GetBytes(options.SigningKey));
        signingCredentials = new SigningCredentials(
            signingKey,
            SecurityAlgorithms.HmacSha256);
    }

    public AccessTokenResult Create(User user)
    {
        ArgumentNullException.ThrowIfNull(user);

        DateTime issuedAtUtc = timeProvider.GetUtcNow().UtcDateTime;
        DateTime expiresAtUtc = issuedAtUtc.AddMinutes(options.AccessTokenLifetimeMinutes);
        Claim[] claims =
        [
            new(JwtRegisteredClaimNames.Sub, user.Id.ToString()),
            new(JwtRegisteredClaimNames.Email, user.Email),
        ];

        JwtSecurityToken token = new(
            issuer: options.Issuer,
            audience: options.Audience,
            claims: claims,
            notBefore: issuedAtUtc,
            expires: expiresAtUtc,
            signingCredentials: signingCredentials);

        return new AccessTokenResult(
            tokenHandler.WriteToken(token),
            expiresAtUtc);
    }
}
