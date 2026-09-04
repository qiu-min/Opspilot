using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using OpsPilot.Api.Features.Auth.Contracts.Responses;

namespace OpsPilot.IntegrationTests;

public sealed class ConversationEndpointTests : IClassFixture<FilesTestFactory>
{
    private readonly FilesTestFactory factory;
    private readonly HttpClient httpClient;

    public ConversationEndpointTests(FilesTestFactory factory)
    {
        this.factory = factory;
        httpClient = factory.CreateClient();
    }

    [Fact]
    public async Task PostConversation_WithAuthenticatedUserReturnsCreatedWithoutInternalFields()
    {
        LoginResponse login = await RegisterAndLoginAsync("create");
        using HttpRequestMessage request = CreateAuthenticatedRequest(
            HttpMethod.Post,
            "/api/conversations",
            login.AccessToken);

        using HttpResponseMessage response = await httpClient.SendAsync(request);

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        JsonElement body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Guid conversationId = body.GetProperty("id").GetGuid();
        Assert.NotEqual(Guid.Empty, conversationId);
        Assert.Equal("New conversation", body.GetProperty("title").GetString());
        Assert.NotEqual(default, body.GetProperty("createdAtUtc").GetDateTime());
        Assert.Equal(
            body.GetProperty("createdAtUtc").GetDateTime(),
            body.GetProperty("updatedAtUtc").GetDateTime());
        Assert.False(body.TryGetProperty("agentSessionId", out _));
        Assert.False(body.TryGetProperty("userId", out _));
    }

    [Fact]
    public async Task GetConversations_ReturnsCurrentUsersConversationsInUpdatedOrder()
    {
        LoginResponse login = await RegisterAndLoginAsync("list");
        Guid firstId = await CreateConversationAsync(login.AccessToken);
        Guid secondId = await CreateConversationAsync(login.AccessToken);

        using HttpRequestMessage request = CreateAuthenticatedRequest(
            HttpMethod.Get,
            "/api/conversations",
            login.AccessToken);
        using HttpResponseMessage response = await httpClient.SendAsync(request);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        JsonElement[] conversations = await response.Content.ReadFromJsonAsync<JsonElement[]>()
            ?? throw new InvalidOperationException("Conversation response was empty.");
        JsonElement[] userConversations = conversations
            .Where(conversation =>
            {
                Guid id = conversation.GetProperty("id").GetGuid();
                return id == firstId || id == secondId;
            })
            .ToArray();

        Assert.Equal(2, userConversations.Length);
        Assert.Contains(
            userConversations,
            conversation => conversation.GetProperty("id").GetGuid() == firstId);
        Assert.Contains(
            userConversations,
            conversation => conversation.GetProperty("id").GetGuid() == secondId);
        Assert.True(
            userConversations[0].GetProperty("updatedAtUtc").GetDateTime() >=
            userConversations[1].GetProperty("updatedAtUtc").GetDateTime());
        Assert.All(userConversations, conversation =>
        {
            Assert.False(conversation.TryGetProperty("agentSessionId", out _));
            Assert.False(conversation.TryGetProperty("userId", out _));
            Assert.Equal("New conversation", conversation.GetProperty("title").GetString());
        });
    }

    [Fact]
    public async Task GetConversations_DoesNotReturnAnotherUsersConversation()
    {
        LoginResponse owner = await RegisterAndLoginAsync("owner");
        LoginResponse otherUser = await RegisterAndLoginAsync("other");
        Guid ownerConversationId = await CreateConversationAsync(owner.AccessToken);

        using HttpRequestMessage request = CreateAuthenticatedRequest(
            HttpMethod.Get,
            "/api/conversations",
            otherUser.AccessToken);
        using HttpResponseMessage response = await httpClient.SendAsync(request);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        JsonElement[] conversations = await response.Content.ReadFromJsonAsync<JsonElement[]>()
            ?? throw new InvalidOperationException("Conversation response was empty.");
        Assert.DoesNotContain(
            conversations,
            conversation => conversation.GetProperty("id").GetGuid() == ownerConversationId);
    }

    [Fact]
    public async Task ConversationEndpoints_WithoutAuthenticationReturnUnauthorized()
    {
        using HttpResponseMessage postResponse = await httpClient.PostAsync(
            "/api/conversations",
            content: null);
        using HttpResponseMessage getResponse = await httpClient.GetAsync(
            "/api/conversations");

        Assert.Equal(HttpStatusCode.Unauthorized, postResponse.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, getResponse.StatusCode);
    }

    private async Task<Guid> CreateConversationAsync(string accessToken)
    {
        using HttpRequestMessage request = CreateAuthenticatedRequest(
            HttpMethod.Post,
            "/api/conversations",
            accessToken);
        using HttpResponseMessage response = await httpClient.SendAsync(request);
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);

        JsonElement body = await response.Content.ReadFromJsonAsync<JsonElement>();
        return body.GetProperty("id").GetGuid();
    }

    private async Task<LoginResponse> RegisterAndLoginAsync(string label)
    {
        string email = $"conversation-{label}-{Guid.NewGuid():N}@example.com";
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

    private static HttpRequestMessage CreateAuthenticatedRequest(
        HttpMethod method,
        string uri,
        string accessToken)
    {
        var request = new HttpRequestMessage(method, uri);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
        return request;
    }
}
