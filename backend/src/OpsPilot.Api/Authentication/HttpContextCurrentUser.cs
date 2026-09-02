using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using Microsoft.AspNetCore.Http;
using OpsPilot.Application.Abstractions.Security;
using OpsPilot.Application.Exceptions;

namespace OpsPilot.Api.Authentication;

public sealed class HttpContextCurrentUser(
    IHttpContextAccessor httpContextAccessor) : ICurrentUser
{
    public Guid UserId
    {
        get
        {
            ClaimsPrincipal? principal = httpContextAccessor.HttpContext?.User;
            if (principal?.Identity?.IsAuthenticated != true)
            {
                throw new ApplicationUnauthorizedException("Authentication is required.");
            }

            string? value = principal.FindFirst(JwtRegisteredClaimNames.Sub)?.Value;
            if (!Guid.TryParse(value, out Guid userId) || userId == Guid.Empty)
            {
                throw new ApplicationUnauthorizedException(
                    "Authenticated user context is invalid.");
            }

            return userId;
        }
    }
}
