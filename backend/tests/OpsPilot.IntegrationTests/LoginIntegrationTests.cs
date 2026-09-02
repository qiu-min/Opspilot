using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using OpsPilot.Api.Features.Auth.Contracts.Responses;
using OpsPilot.Infrastructure.Security;
using OpsPilot.IntegrationTests.Infrastructure;

namespace OpsPilot.IntegrationTests;

public sealed class LoginIntegrationTests : IClassFixture<RegisterTestFactory>
{
    private readonly HttpClient httpClient;

    public LoginIntegrationTests(RegisterTestFactory factory)
    {
        httpClient = factory.CreateClient();
    }

    [Fact]
    public async Task PostLogin_AfterRegisteringUserReturnsJwtWithoutPasswordHash()
    {
        string email = $"login-{Guid.NewGuid():N}@example.com";
        const string password = "password123";
        await RegisterAsync(email, password);

        using HttpResponseMessage response = await httpClient.PostAsJsonAsync(
            "/api/auth/login",
            new { email, password });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        LoginResponse? body = await response.Content.ReadFromJsonAsync<LoginResponse>();
        Assert.NotNull(body);
        Assert.NotEqual(Guid.Empty, body!.UserId);
        Assert.Equal(email, body.Email);
        Assert.NotEmpty(body.AccessToken);
        Assert.True(body.ExpiresAtUtc > DateTime.UtcNow);

        string responseBody = await response.Content.ReadAsStringAsync();
        Assert.DoesNotContain("passwordHash", responseBody, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task PostLogin_NormalizesEmailBeforeLookingUpUser()
    {
        string email = $"Login-{Guid.NewGuid():N}@Example.com";
        const string password = "password123";
        await RegisterAsync($"  {email}  ", password);

        using HttpResponseMessage response = await httpClient.PostAsJsonAsync(
            "/api/auth/login",
            new
            {
                email = $"  {email.ToUpperInvariant()}  ",
                password,
            });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        LoginResponse? body = await response.Content.ReadFromJsonAsync<LoginResponse>();
        Assert.NotNull(body);
        Assert.Equal(email.ToLowerInvariant(), body!.Email);
    }

    [Fact]
    public async Task PostLogin_WithUnknownUserOrWrongPasswordReturnsSameUnauthorizedProblemDetail()
    {
        string email = $"login-{Guid.NewGuid():N}@example.com";
        await RegisterAsync(email, "password123");

        using HttpResponseMessage wrongPasswordResponse = await httpClient.PostAsJsonAsync(
            "/api/auth/login",
            new { email, password = "wrong-password" });
        using HttpResponseMessage unknownUserResponse = await httpClient.PostAsJsonAsync(
            "/api/auth/login",
            new
            {
                email = $"unknown-{Guid.NewGuid():N}@example.com",
                password = "password123",
            });

        Assert.Equal(HttpStatusCode.Unauthorized, wrongPasswordResponse.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, unknownUserResponse.StatusCode);
        string? wrongPasswordDetail = await ReadProblemDetailAsync(wrongPasswordResponse);
        string? unknownUserDetail = await ReadProblemDetailAsync(unknownUserResponse);
        Assert.Equal(wrongPasswordDetail, unknownUserDetail);
        Assert.Equal("Invalid email or password.", wrongPasswordDetail);
    }

    private async Task RegisterAsync(string email, string password)
    {
        using HttpResponseMessage response = await httpClient.PostAsJsonAsync(
            "/api/auth/register",
            new { email, password });

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
    }

    private static async Task<string?> ReadProblemDetailAsync(HttpResponseMessage response)
    {
        JsonElement body = await response.Content.ReadFromJsonAsync<JsonElement>();
        return body.GetProperty("detail").GetString();
    }
}

public sealed class JwtBearerIntegrationTests : IClassFixture<RegisterTestFactory>
{
    private readonly HttpClient httpClient;

    public JwtBearerIntegrationTests(RegisterTestFactory factory)
    {
        httpClient = factory.CreateClient();
    }

    [Fact]
    public async Task ProtectedTestEndpoint_WithValidLoginTokenReturnsSuccess()
    {
        LoginResponse login = await RegisterAndLoginAsync();

        using HttpRequestMessage request = CreateAuthenticatedRequest(login.AccessToken);
        using HttpResponseMessage response = await httpClient.SendAsync(request);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task ProtectedTestEndpoint_WithTokenSignedByDifferentKeyReturnsUnauthorized()
    {
        LoginResponse login = await RegisterAndLoginAsync();
        string invalidToken = login.AccessToken[..^1] +
            (login.AccessToken[^1] == 'a' ? 'b' : 'a');

        using HttpRequestMessage request = CreateAuthenticatedRequest(invalidToken);
        using HttpResponseMessage response = await httpClient.SendAsync(request);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task ProtectedTestEndpoint_WithExpiredTokenReturnsUnauthorized()
    {
        var provider = new JwtAccessTokenProvider(
            new JwtOptions
            {
                Issuer = "OpsPilot",
                Audience = "OpsPilot.Web",
                SigningKey = TestJwtConfiguration.SigningKey,
                AccessTokenLifetimeMinutes = 60,
            },
            new FixedTimeProvider(DateTimeOffset.UtcNow.AddHours(-2)));
        var user = OpsPilot.Domain.Users.User.Create(
            "expired@example.com",
            "hashed-password",
            DateTime.UtcNow.AddHours(-2));
        string expiredToken = provider.Create(user).Token;

        using HttpRequestMessage request = CreateAuthenticatedRequest(expiredToken);
        using HttpResponseMessage response = await httpClient.SendAsync(request);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    private async Task<LoginResponse> RegisterAndLoginAsync()
    {
        string email = $"jwt-{Guid.NewGuid():N}@example.com";
        const string password = "password123";
        using HttpResponseMessage registerResponse = await httpClient.PostAsJsonAsync(
            "/api/auth/register",
            new { email, password });
        Assert.Equal(HttpStatusCode.Created, registerResponse.StatusCode);

        using HttpResponseMessage loginResponse = await httpClient.PostAsJsonAsync(
            "/api/auth/login",
            new { email, password });
        Assert.Equal(HttpStatusCode.OK, loginResponse.StatusCode);

        LoginResponse? login = await loginResponse.Content.ReadFromJsonAsync<LoginResponse>();
        Assert.NotNull(login);
        return login!;
    }

    private static HttpRequestMessage CreateAuthenticatedRequest(string token)
    {
        var request = new HttpRequestMessage(
            HttpMethod.Get,
            "/__integration-test/protected");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        return request;
    }

    private sealed class FixedTimeProvider(DateTimeOffset currentTime) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => currentTime;
    }
}

[ApiController]
[Authorize]
[Route("__integration-test/protected")]
public sealed class TestProtectedController : ControllerBase
{
    [HttpGet]
    public IActionResult Get() => Ok();
}
