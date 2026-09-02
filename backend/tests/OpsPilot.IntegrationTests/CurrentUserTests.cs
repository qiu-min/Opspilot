using System.Security.Claims;
using Microsoft.AspNetCore.Http;
using OpsPilot.Api.Authentication;
using OpsPilot.Application.Exceptions;

namespace OpsPilot.IntegrationTests;

public sealed class CurrentUserTests
{
    private static readonly Guid UserId =
        Guid.Parse("ffffffff-ffff-ffff-ffff-ffffffffffff");

    [Fact]
    public void UserId_WithAuthenticatedStandardSubClaimReturnsUserId()
    {
        var context = new DefaultHttpContext
        {
            User = new ClaimsPrincipal(new ClaimsIdentity(
                [new Claim("sub", UserId.ToString())],
                "Bearer"))
        };
        var currentUser = new HttpContextCurrentUser(new HttpContextAccessor
        {
            HttpContext = context
        });

        Assert.Equal(UserId, currentUser.UserId);
    }

    [Fact]
    public void UserId_WithoutAuthenticatedContextThrowsUnauthorized()
    {
        var currentUser = new HttpContextCurrentUser(new HttpContextAccessor());

        Assert.Throws<ApplicationUnauthorizedException>(() => currentUser.UserId);
    }

    [Fact]
    public void UserId_WithInvalidSubClaimThrowsUnauthorized()
    {
        var context = new DefaultHttpContext
        {
            User = new ClaimsPrincipal(new ClaimsIdentity(
                [new Claim("sub", "not-a-guid")],
                "Bearer"))
        };
        var currentUser = new HttpContextCurrentUser(new HttpContextAccessor
        {
            HttpContext = context
        });

        Assert.Throws<ApplicationUnauthorizedException>(() => currentUser.UserId);
    }
}
