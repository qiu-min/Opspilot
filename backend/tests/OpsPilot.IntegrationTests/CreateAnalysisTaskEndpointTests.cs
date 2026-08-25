using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;

namespace OpsPilot.IntegrationTests;

public sealed class CreateAnalysisTaskEndpointTests : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly HttpClient httpClient;

    public CreateAnalysisTaskEndpointTests(WebApplicationFactory<Program> factory)
    {
        httpClient = factory.CreateClient();
    }

    [Fact]
    public async Task PostAnalysisTask_ReturnsCreatedPendingTask()
    {
        using HttpResponseMessage response = await httpClient.PostAsJsonAsync(
            "/api/analysis-tasks",
            new
            {
                fileId = Guid.NewGuid(),
                prompt = "Analyze this Excel file"
            });

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);

        JsonElement body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.NotEqual(Guid.Empty, body.GetProperty("id").GetGuid());
        Assert.Equal("Pending", body.GetProperty("status").GetString());
        Assert.NotEqual(default, body.GetProperty("createdAtUtc").GetDateTime());
    }

    [Fact]
    public async Task PostAnalysisTask_WithBlankPrompt_ReturnsBadRequestProblemDetails()
    {
        using HttpResponseMessage response = await httpClient.PostAsJsonAsync(
            "/api/analysis-tasks",
            new
            {
                fileId = Guid.NewGuid(),
                prompt = "  "
            });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Contains(
            "problem+json",
            response.Content.Headers.ContentType?.MediaType ?? string.Empty,
            StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task PostAnalysisTask_WithPromptTooLong_ReturnsBadRequestProblemDetails()
    {
        using HttpResponseMessage response = await httpClient.PostAsJsonAsync(
            "/api/analysis-tasks",
            new
            {
                fileId = Guid.NewGuid(),
                prompt = new string('a', 4001)
            });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Contains(
            "problem+json",
            response.Content.Headers.ContentType?.MediaType ?? string.Empty,
            StringComparison.OrdinalIgnoreCase);
    }
}
