using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using OpsPilot.Api.Features.Auth.Contracts.Responses;
using OpsPilot.Application.Abstractions.AgentService;

namespace OpsPilot.IntegrationTests;

public sealed class ConversationOwnershipIntegrationTests
    : IClassFixture<ConversationOwnershipTestFactory>
{
    private readonly ConversationOwnershipTestFactory factory;
    private readonly HttpClient httpClient;

    public ConversationOwnershipIntegrationTests(ConversationOwnershipTestFactory factory)
    {
        this.factory = factory;
        httpClient = factory.CreateClient();
    }

    [Fact]
    public async Task PostTurn_WhenAnotherUserReferencesTheFileReturnsNotFoundWithoutCallingAgent()
    {
        LoginResponse owner = await RegisterAndLoginAsync("owner");
        LoginResponse otherUser = await RegisterAndLoginAsync("other");
        Guid fileId = await UploadFileAsync(owner.AccessToken);

        factory.AgentClient.Reset();
        using (HttpRequestMessage ownerRequest = CreateConversationRequest(
                   owner.AccessToken,
                   fileId))
        using (HttpResponseMessage ownerResponse = await httpClient.SendAsync(ownerRequest))
        {
            Assert.Equal(HttpStatusCode.OK, ownerResponse.StatusCode);
        }

        Assert.Equal(1, factory.AgentClient.CallCount);

        factory.AgentClient.Reset();
        using (HttpRequestMessage otherRequest = CreateConversationRequest(
                   otherUser.AccessToken,
                   fileId))
        using (HttpResponseMessage otherResponse = await httpClient.SendAsync(otherRequest))
        {
            Assert.Equal(HttpStatusCode.NotFound, otherResponse.StatusCode);
        }

        Assert.Equal(0, factory.AgentClient.CallCount);
    }

    private async Task<LoginResponse> RegisterAndLoginAsync(string label)
    {
        string email = $"ownership-{label}-{Guid.NewGuid():N}@example.com";
        const string password = "Password123!";

        using HttpResponseMessage registerResponse = await httpClient.PostAsJsonAsync(
            "/api/auth/register",
            new { email, password });
        Assert.Equal(HttpStatusCode.Created, registerResponse.StatusCode);

        using HttpResponseMessage loginResponse = await httpClient.PostAsJsonAsync(
            "/api/auth/login",
            new { email, password });
        Assert.Equal(HttpStatusCode.OK, loginResponse.StatusCode);

        return (await loginResponse.Content.ReadFromJsonAsync<LoginResponse>())!;
    }

    private async Task<Guid> UploadFileAsync(string accessToken)
    {
        using var form = new MultipartFormDataContent();
        using var fileContent = new ByteArrayContent([80, 75, 3, 4]);
        fileContent.Headers.ContentType = new MediaTypeHeaderValue(
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        form.Add(fileContent, "file", "owned.xlsx");

        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/files")
        {
            Content = form
        };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);

        using HttpResponseMessage response = await httpClient.SendAsync(request);
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);

        JsonElement body = await response.Content.ReadFromJsonAsync<JsonElement>();
        return body.GetProperty("id").GetGuid();
    }

    private static HttpRequestMessage CreateConversationRequest(
        string accessToken,
        Guid fileId)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, "/api/conversations/turns")
        {
            Content = JsonContent.Create(new
            {
                fileId,
                message = "Inspect the workbook."
            })
        };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
        return request;
    }
}

public sealed class ConversationOwnershipTestFactory : FilesTestFactory
{
    public ConversationOwnershipTestFactory()
    {
        AgentClient = new OwnershipTestAgentConversationClient();
    }

    public OwnershipTestAgentConversationClient AgentClient { get; }

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        base.ConfigureWebHost(builder);
        builder.ConfigureServices(services =>
        {
            services.RemoveAll<IAgentConversationClient>();
            services.AddSingleton<IAgentConversationClient>(AgentClient);
        });
    }
}

public sealed class OwnershipTestAgentConversationClient : IAgentConversationClient
{
    public int CallCount { get; private set; }

    public Task<AgentConversationTurnResult> RunTurnAsync(
        AgentConversationTurnRequest request,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        CallCount++;
        return Task.FromResult(new AgentConversationTurnResult(
            request.SessionId ?? Guid.NewGuid(),
            "ownership-leaf",
            "completed",
            "Workbook inspected."));
    }

    public void Reset()
    {
        CallCount = 0;
    }
}
