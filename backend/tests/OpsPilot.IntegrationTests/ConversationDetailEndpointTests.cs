using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using OpsPilot.Application.Abstractions.AgentService;
using OpsPilot.Domain.Conversations;

namespace OpsPilot.IntegrationTests;

public sealed class ConversationDetailEndpointTests : IClassFixture<ConversationTestFactory>
{
    private static readonly Guid SessionId =
        Guid.Parse("11111111-1111-1111-1111-111111111111");

    private readonly ConversationTestFactory factory;
    private readonly HttpClient httpClient;

    public ConversationDetailEndpointTests(ConversationTestFactory factory)
    {
        this.factory = factory;
        httpClient = factory.CreateClient();
    }

    [Fact]
    public async Task GetDetail_WhenConversationHasNoSessionReturnsEmptyItemsWithoutCallingAgent()
    {
        Conversation conversation = CreateConversation(factory.CurrentUserId);
        factory.Conversation = conversation;
        factory.AgentClient.Reset();

        using HttpResponseMessage response = await httpClient.GetAsync(
            $"/api/conversations/{conversation.Id}");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        JsonElement body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(conversation.Id, body.GetProperty("id").GetGuid());
        Assert.Equal("New conversation", body.GetProperty("title").GetString());
        Assert.Empty(body.GetProperty("items").EnumerateArray());
        Assert.Equal(0, factory.AgentClient.HistoryCallCount);
    }

    [Fact]
    public async Task GetDetail_WhenConversationHasSessionReturnsMappedHistoryWithoutInternalFields()
    {
        Conversation conversation = CreateConversation(factory.CurrentUserId);
        conversation.BindAgentSession(SessionId, DateTime.UtcNow.AddMinutes(1));
        factory.Conversation = conversation;
        factory.AgentClient.Reset();
        factory.AgentClient.History = new AgentConversationHistory(
            "entry-2",
            [
                new AgentConversationHistoryMessageItem(
                    "entry-1",
                    "user",
                    "hello",
                    new DateTimeOffset(2026, 9, 5, 8, 0, 0, TimeSpan.Zero)),
                new AgentConversationHistoryMessageItem(
                    "entry-2",
                    "assistant",
                    "Hi.",
                    new DateTimeOffset(2026, 9, 5, 8, 0, 1, TimeSpan.Zero)),
            ]);

        using HttpResponseMessage response = await httpClient.GetAsync(
            $"/api/conversations/{conversation.Id}");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        string responseBody = await response.Content.ReadAsStringAsync();
        JsonElement body = JsonSerializer.Deserialize<JsonElement>(responseBody);
        JsonElement[] items = body.GetProperty("items").EnumerateArray().ToArray();
        Assert.Equal(2, items.Length);
        Assert.Equal("entry-1", items[0].GetProperty("id").GetString());
        Assert.Equal("user", items[0].GetProperty("role").GetString());
        Assert.Equal("hello", items[0].GetProperty("text").GetString());
        Assert.Equal("entry-2", items[1].GetProperty("id").GetString());
        Assert.Equal("assistant", items[1].GetProperty("role").GetString());
        Assert.Equal("Hi.", items[1].GetProperty("text").GetString());
        Assert.Equal(SessionId, factory.AgentClient.RequestedHistorySessionId);
        Assert.Equal(1, factory.AgentClient.HistoryCallCount);
        Assert.DoesNotContain("agentSessionId", responseBody, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("sessionId", responseBody, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("userId", responseBody, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("leafId", responseBody, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("thinking", responseBody, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task GetDetail_WhenHistoryHasToolExecutionReturnsItInOriginalOrder()
    {
        Conversation conversation = CreateConversation(factory.CurrentUserId);
        conversation.BindAgentSession(SessionId, DateTime.UtcNow.AddMinutes(1));
        factory.Conversation = conversation;
        factory.AgentClient.Reset();
        factory.AgentClient.History = new AgentConversationHistory(
            "entry-5",
            [
                new AgentConversationHistoryMessageItem(
                    "entry-1",
                    "user",
                    "question",
                    new DateTimeOffset(2026, 9, 5, 8, 0, 0, TimeSpan.Zero)),
                new AgentConversationHistoryMessageItem(
                    "entry-2",
                    "assistant",
                    "I will inspect the workbook.",
                    new DateTimeOffset(2026, 9, 5, 8, 0, 1, TimeSpan.Zero)),
                new AgentConversationHistoryToolExecutionItem(
                    "entry-3",
                    "call-1",
                    "get_workbook_info",
                    "completed",
                    new DateTimeOffset(2026, 9, 5, 8, 0, 2, TimeSpan.Zero)),
                new AgentConversationHistoryMessageItem(
                    "entry-4",
                    "assistant",
                    "Here is the result.",
                    new DateTimeOffset(2026, 9, 5, 8, 0, 3, TimeSpan.Zero)),
                new AgentConversationHistoryToolExecutionItem(
                    "entry-5",
                    "call-2",
                    "get_sheet_profile",
                    "failed",
                    new DateTimeOffset(2026, 9, 5, 8, 0, 4, TimeSpan.Zero)),
            ]);

        using HttpResponseMessage response = await httpClient.GetAsync(
            $"/api/conversations/{conversation.Id}");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        JsonElement body = await response.Content.ReadFromJsonAsync<JsonElement>();
        JsonElement[] items = body.GetProperty("items").EnumerateArray().ToArray();
        Assert.Equal(["message", "message", "tool_execution", "message", "tool_execution"],
            items.Select(item => item.GetProperty("type").GetString() ?? string.Empty).ToArray());
        Assert.Equal("call-1", items[2].GetProperty("callId").GetString());
        Assert.Equal("completed", items[2].GetProperty("status").GetString());
        Assert.Equal("call-2", items[4].GetProperty("callId").GetString());
        Assert.Equal("failed", items[4].GetProperty("status").GetString());
        string responseBody = JsonSerializer.Serialize(body);
        Assert.DoesNotContain("private", responseBody, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task GetDetail_WhenConversationDoesNotExistReturnsNotFoundWithoutCallingAgent()
    {
        factory.Conversation = null;
        factory.AgentClient.Reset();

        using HttpResponseMessage response = await httpClient.GetAsync(
            $"/api/conversations/{Guid.NewGuid()}");

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Equal(0, factory.AgentClient.HistoryCallCount);
    }

    private static Conversation CreateConversation(Guid userId) =>
        Conversation.Create(
            userId,
            Conversation.DefaultTitle,
            new DateTime(2026, 9, 5, 7, 0, 0, DateTimeKind.Utc));
}
