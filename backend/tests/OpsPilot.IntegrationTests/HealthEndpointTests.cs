using Microsoft.AspNetCore.Mvc.Testing;

namespace OpsPilot.IntegrationTests;

public sealed class HealthEndpointTests : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly HttpClient httpClient;

    public HealthEndpointTests(WebApplicationFactory<Program> factory)
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
