using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;
using OpsPilot.Application.Abstractions.Persistence;
using OpsPilot.Domain.Users;

namespace OpsPilot.IntegrationTests;

public sealed class ExceptionHandlingTests : IClassFixture<UnknownExceptionTestFactory>
{
    private readonly HttpClient httpClient;

    public ExceptionHandlingTests(UnknownExceptionTestFactory factory)
    {
        httpClient = factory.CreateClient();
    }

    [Fact]
    public async Task PostRegister_WhenUnknownExceptionOccursDoesNotExposeInternalMessage()
    {
        using HttpResponseMessage response = await httpClient.PostAsJsonAsync(
            "/api/auth/register",
            new { email = "user@example.com", password = "password123" });

        string body = await response.Content.ReadAsStringAsync();

        Assert.Equal(HttpStatusCode.InternalServerError, response.StatusCode);
        Assert.DoesNotContain("sensitive database failure", body, StringComparison.Ordinal);
        Assert.DoesNotContain("Npgsql", body, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("An unexpected error occurred.", body, StringComparison.Ordinal);
    }
}

public sealed class UnknownExceptionTestFactory : WebApplicationFactory<Program>
{
    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Testing");
        builder.UseSetting(
            "ConnectionStrings:Postgres",
            "Host=localhost;Port=5432;Database=opspilot_test;Username=opspilot;Password=opspilot_dev_password");
        builder.UseSetting("AgentService:BaseUrl", "http://127.0.0.1:3000");
        builder.ConfigureLogging(logging =>
        {
            logging.ClearProviders();
            logging.AddConsole();
        });
        builder.ConfigureServices(services =>
        {
            services.RemoveAll<IUserRepository>();
            services.AddSingleton<IUserRepository, ThrowingUserRepository>();
        });
    }
}

public sealed class ThrowingUserRepository : IUserRepository
{
    public Task<User?> GetByEmailAsync(
        string email,
        CancellationToken cancellationToken)
    {
        throw new InvalidOperationException("sensitive database failure");
    }

    public Task<User?> GetByIdAsync(
        Guid userId,
        CancellationToken cancellationToken)
    {
        throw new NotSupportedException();
    }

    public Task AddAsync(User user, CancellationToken cancellationToken)
    {
        throw new NotSupportedException();
    }

    public Task SaveChangesAsync(CancellationToken cancellationToken)
    {
        throw new NotSupportedException();
    }
}
