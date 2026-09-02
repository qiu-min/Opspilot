using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Logging;
using OpsPilot.IntegrationTests.Infrastructure;

namespace OpsPilot.IntegrationTests;

public sealed class HealthEndpointTests : IClassFixture<HealthTestFactory>
{
    private readonly HttpClient httpClient;

    public HealthEndpointTests(HealthTestFactory factory)
    {
        httpClient = factory.CreateClient();
    }

    [Fact]
    public async Task GetHealth_ReturnsSuccess()
    {
        using HttpResponseMessage response = await httpClient.GetAsync("/health");

        Assert.True(response.IsSuccessStatusCode);
    }
}

public sealed class HealthTestFactory : WebApplicationFactory<Program>
{
    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Testing");
        builder.UseSetting(
            "ConnectionStrings:Postgres",
            "Host=localhost;Port=5432;Database=unused;Username=unused;Password=unused");
        builder.UseSetting("AgentService:BaseUrl", "http://127.0.0.1:3000");
        builder.UseSetting("Jwt:SigningKey", TestJwtConfiguration.SigningKey);
        builder.ConfigureLogging(logging =>
        {
            logging.ClearProviders();
            logging.AddConsole();
        });
    }
}
