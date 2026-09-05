using OpsPilot.Application.Abstractions.AgentService;
using OpsPilot.Application.Abstractions.Persistence;
using OpsPilot.Application.Abstractions.Security;
using OpsPilot.Application.Conversations.GetDetail;
using OpsPilot.Application.Exceptions;
using OpsPilot.Domain.Conversations;

namespace OpsPilot.UnitTests;

public sealed class GetConversationDetailHandlerTests
{
    private static readonly Guid CurrentUserId =
        Guid.Parse("cccccccc-cccc-cccc-cccc-cccccccccccc");

    private static readonly Guid OtherUserId =
        Guid.Parse("dddddddd-dddd-dddd-dddd-dddddddddddd");

    private static readonly Guid SessionId =
        Guid.Parse("11111111-1111-1111-1111-111111111111");

    private static readonly DateTime CreatedAtUtc =
        new(2026, 9, 5, 8, 0, 0, DateTimeKind.Utc);

    [Fact]
    public async Task HandleAsync_WhenConversationHasNoSessionReturnsEmptyItemsWithoutLoadingHistory()
    {
        Conversation conversation = CreateConversation(CurrentUserId);
        var repository = new FakeConversationRepository(conversation);
        var agentClient = new FakeAgentConversationClient();
        var handler = CreateHandler(repository, agentClient);

        GetConversationDetailResult result = await handler.HandleAsync(
            new GetConversationDetailQuery(conversation.Id),
            CancellationToken.None);

        Assert.Equal(conversation.Id, result.Id);
        Assert.Equal(conversation.Title, result.Title);
        Assert.Empty(result.Items);
        Assert.Equal(0, agentClient.HistoryCallCount);
    }

    [Fact]
    public async Task HandleAsync_WhenConversationHasSessionLoadsAndMapsHistoryItems()
    {
        Conversation conversation = CreateConversation(CurrentUserId);
        conversation.BindAgentSession(SessionId, CreatedAtUtc.AddMinutes(1));
        var repository = new FakeConversationRepository(conversation);
        var agentClient = new FakeAgentConversationClient
        {
            History = new AgentConversationHistory(
                "entry-2",
                [
                    new AgentConversationHistoryItem(
                        "message",
                        "entry-1",
                        "user",
                        "hello",
                        new DateTimeOffset(CreatedAtUtc.AddMinutes(2))),
                    new AgentConversationHistoryItem(
                        "message",
                        "entry-2",
                        "assistant",
                        "Hi.",
                        new DateTimeOffset(CreatedAtUtc.AddMinutes(2).AddSeconds(1))),
                ]),
        };
        var handler = CreateHandler(repository, agentClient);

        GetConversationDetailResult result = await handler.HandleAsync(
            new GetConversationDetailQuery(conversation.Id),
            CancellationToken.None);

        Assert.Equal(SessionId, agentClient.RequestedSessionId);
        Assert.Equal(1, agentClient.HistoryCallCount);
        Assert.Collection(
            result.Items,
            item =>
            {
                Assert.Equal("entry-1", item.Id);
                Assert.Equal("user", item.Role);
                Assert.Equal("hello", item.Text);
            },
            item =>
            {
                Assert.Equal("entry-2", item.Id);
                Assert.Equal("assistant", item.Role);
                Assert.Equal("Hi.", item.Text);
            });
    }

    [Fact]
    public async Task HandleAsync_WhenConversationDoesNotExistReturnsNotFoundWithoutCallingAgent()
    {
        var repository = new FakeConversationRepository(null);
        var agentClient = new FakeAgentConversationClient();
        var handler = CreateHandler(repository, agentClient);

        await Assert.ThrowsAsync<ApplicationNotFoundException>(() => handler.HandleAsync(
            new GetConversationDetailQuery(Guid.NewGuid()),
            CancellationToken.None));

        Assert.Equal(0, agentClient.HistoryCallCount);
    }

    [Fact]
    public async Task HandleAsync_WhenConversationBelongsToAnotherUserReturnsNotFoundWithoutCallingAgent()
    {
        Conversation conversation = CreateConversation(OtherUserId);
        var repository = new FakeConversationRepository(conversation);
        var agentClient = new FakeAgentConversationClient();
        var handler = CreateHandler(repository, agentClient);

        await Assert.ThrowsAsync<ApplicationNotFoundException>(() => handler.HandleAsync(
            new GetConversationDetailQuery(conversation.Id),
            CancellationToken.None));

        Assert.Equal(0, agentClient.HistoryCallCount);
    }

    private static GetConversationDetailHandler CreateHandler(
        FakeConversationRepository repository,
        FakeAgentConversationClient agentClient)
    {
        return new GetConversationDetailHandler(
            repository,
            new FakeCurrentUser(CurrentUserId),
            agentClient);
    }

    private static Conversation CreateConversation(Guid userId) =>
        Conversation.Create(userId, Conversation.DefaultTitle, CreatedAtUtc);

    private sealed class FakeCurrentUser(Guid userId) : ICurrentUser
    {
        public Guid UserId { get; } = userId;
    }

    private sealed class FakeConversationRepository(Conversation? conversation)
        : IConversationRepository
    {
        public Task<Conversation?> GetByIdAndUserIdAsync(
            Guid conversationId,
            Guid userId,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return Task.FromResult(
                conversation?.Id == conversationId && conversation.UserId == userId
                    ? conversation
                    : null);
        }

        public Task AddAsync(Conversation value, CancellationToken cancellationToken) =>
            throw new NotSupportedException();

        public Task<IReadOnlyList<Conversation>> ListByUserIdAsync(
            Guid userId,
            CancellationToken cancellationToken) =>
            throw new NotSupportedException();

        public Task SaveChangesAsync(CancellationToken cancellationToken) =>
            throw new NotSupportedException();
    }

    private sealed class FakeAgentConversationClient : IAgentConversationClient
    {
        public AgentConversationHistory History { get; init; } = new(null, []);

        public Guid RequestedSessionId { get; private set; }

        public int HistoryCallCount { get; private set; }

        public Task<AgentConversationHistory> GetHistoryAsync(
            Guid sessionId,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            RequestedSessionId = sessionId;
            HistoryCallCount++;
            return Task.FromResult(History);
        }

        public Task<AgentConversationTurnResult> RunTurnAsync(
            AgentConversationTurnRequest request,
            CancellationToken cancellationToken) =>
            throw new NotSupportedException();
    }
}
