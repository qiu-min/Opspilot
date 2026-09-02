using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using OpsPilot.Infrastructure.Persistence;
using OpsPilot.IntegrationTests.Infrastructure;

namespace OpsPilot.IntegrationTests;

public sealed class RegisterEndpointTests : IClassFixture<RegisterTestFactory>
{
    private readonly RegisterTestFactory factory;
    private readonly HttpClient httpClient;

    public RegisterEndpointTests(RegisterTestFactory factory)
    {
        this.factory = factory;
        httpClient = factory.CreateClient();
    }

    [Fact]
    public async Task PostRegister_ReturnsCreatedAndStoresNormalizedUserWithHash()
    {
        string email = $"Register-{Guid.NewGuid():N}@Example.com";
        const string password = "password123";

        using HttpResponseMessage response = await httpClient.PostAsJsonAsync(
            "/api/auth/register",
            new
            {
                email = $"  {email}  ",
                password
            });

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);

        JsonElement body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Guid userId = body.GetProperty("id").GetGuid();
        Assert.NotEqual(Guid.Empty, userId);
        Assert.Equal(email.ToLowerInvariant(), body.GetProperty("email").GetString());
        Assert.NotEqual(default, body.GetProperty("createdAtUtc").GetDateTime());
        Assert.False(body.TryGetProperty("password", out _));
        Assert.False(body.TryGetProperty("passwordHash", out _));

        await using AsyncServiceScope scope = factory.Services.CreateAsyncScope();
        UserRecord user = await scope.ServiceProvider
            .GetRequiredService<OpsPilotDbContext>()
            .Users
            .Where(user => user.Id == userId)
            .Select(user => new UserRecord(user.Email, user.PasswordHash))
            .SingleAsync();

        Assert.Equal(email.ToLowerInvariant(), user.Email);
        Assert.NotEqual(password, user.PasswordHash);
        Assert.NotEmpty(user.PasswordHash);
    }

    [Fact]
    public async Task PostRegister_WithExistingNormalizedEmailReturnsConflict()
    {
        string email = $"duplicate-{Guid.NewGuid():N}@example.com";

        using HttpResponseMessage firstResponse = await httpClient.PostAsJsonAsync(
            "/api/auth/register",
            new { email, password = "password123" });
        Assert.Equal(HttpStatusCode.Created, firstResponse.StatusCode);

        using HttpResponseMessage duplicateResponse = await httpClient.PostAsJsonAsync(
            "/api/auth/register",
            new { email = $" {email.ToUpperInvariant()} ", password = "password123" });

        Assert.Equal(HttpStatusCode.Conflict, duplicateResponse.StatusCode);
        Assert.Contains(
            "problem+json",
            duplicateResponse.Content.Headers.ContentType?.MediaType ?? string.Empty,
            StringComparison.OrdinalIgnoreCase);
        JsonElement duplicateBody = await duplicateResponse.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(
            "A user with this email already exists.",
            duplicateBody.GetProperty("detail").GetString());
    }

    [Fact]
    public async Task PostRegister_WithBlankEmailReturnsBadRequestProblemDetails()
    {
        using HttpResponseMessage response = await httpClient.PostAsJsonAsync(
            "/api/auth/register",
            new { email = "  ", password = "password123" });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Contains(
            "problem+json",
            response.Content.Headers.ContentType?.MediaType ?? string.Empty,
            StringComparison.OrdinalIgnoreCase);
        JsonElement body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("Email cannot be empty.", body.GetProperty("detail").GetString());
    }

    [Fact]
    public async Task PostRegister_WithInvalidEmailFormatReturnsBadRequestProblemDetails()
    {
        using HttpResponseMessage response = await httpClient.PostAsJsonAsync(
            "/api/auth/register",
            new { email = "abc", password = "password123" });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        JsonElement body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("Email format is invalid.", body.GetProperty("detail").GetString());
    }

    private sealed record UserRecord(string Email, string PasswordHash);
}

public sealed class RegisterTestFactory : WebApplicationFactory<Program>
{
    private readonly PostgresTestDatabase _postgresDatabase = new();

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Testing");
        builder.UseSetting("ConnectionStrings:Postgres", _postgresDatabase.ConnectionString);
        builder.UseSetting("AgentService:BaseUrl", "http://127.0.0.1:3000");
        builder.ConfigureLogging(logging =>
        {
            logging.ClearProviders();
            logging.AddConsole();
        });
    }

    protected override IHost CreateHost(IHostBuilder builder)
    {
        _postgresDatabase.Initialize();
        IHost host = base.CreateHost(builder);

        using IServiceScope scope = host.Services.CreateScope();
        OpsPilotDbContext dbContext = scope.ServiceProvider
            .GetRequiredService<OpsPilotDbContext>();
        _postgresDatabase.Migrate(dbContext);

        return host;
    }

    protected override void Dispose(bool disposing)
    {
        if (!disposing)
        {
            base.Dispose(disposing);
            return;
        }

        try
        {
            base.Dispose(disposing);
        }
        finally
        {
            if (disposing)
            {
                _postgresDatabase.Dispose();
            }
        }
    }
}
