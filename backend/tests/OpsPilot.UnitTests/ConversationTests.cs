using OpsPilot.Application.Abstractions.Persistence;
using OpsPilot.Application.Abstractions.Security;
using OpsPilot.Application.Conversations.Create;
using OpsPilot.Application.Conversations.List;
using OpsPilot.Domain.Conversations;

namespace OpsPilot.UnitTests;

public sealed class ConversationTests
{
    private static readonly Guid UserId =
        Guid.Parse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");

    private static readonly DateTime CreatedAtUtc =
        new(2026, 8, 25, 12, 0, 0, DateTimeKind.Utc);

    [Fact]
    public void Create_WithValidValuesCreatesConversationWithGeneratedIdAndTimestamps()
    {
        Conversation conversation = Conversation.Create(
            UserId,
            "  Workbook review  ",
            CreatedAtUtc);

        Assert.NotEqual(Guid.Empty, conversation.Id);
        Assert.Equal(UserId, conversation.UserId);
        Assert.Null(conversation.AgentSessionId);
        Assert.Equal("Workbook review", conversation.Title);
        Assert.Equal(CreatedAtUtc, conversation.CreatedAtUtc);
        Assert.Equal(CreatedAtUtc, conversation.UpdatedAtUtc);
    }

    [Fact]
    public void Create_WithEmptyUserIdRejects()
    {
        Assert.Throws<ArgumentException>(() => Conversation.Create(
            Guid.Empty,
            Conversation.DefaultTitle,
            CreatedAtUtc));
    }

    [Fact]
    public void Create_WithBlankTitleRejects()
    {
        Assert.Throws<ArgumentException>(() => Conversation.Create(
            UserId,
            "  ",
            CreatedAtUtc));
    }

    [Fact]
    public void Create_WithOversizedTitleRejects()
    {
        string title = new('a', Conversation.MaxTitleLength + 1);

        Assert.Throws<ArgumentException>(() => Conversation.Create(
            UserId,
            title,
            CreatedAtUtc));
    }

    [Fact]
    public void BindAgentSession_WithValidSessionBindsAndUpdatesTimestamp()
    {
        Conversation conversation = CreateConversation();
        Guid agentSessionId = Guid.NewGuid();
        DateTime updatedAtUtc = CreatedAtUtc.AddMinutes(1);

        conversation.BindAgentSession(agentSessionId, updatedAtUtc);

        Assert.Equal(agentSessionId, conversation.AgentSessionId);
        Assert.Equal(updatedAtUtc, conversation.UpdatedAtUtc);
    }

    [Fact]
    public void BindAgentSession_WithEmptySessionIdRejects()
    {
        Conversation conversation = CreateConversation();

        Assert.Throws<ArgumentException>(() => conversation.BindAgentSession(
            Guid.Empty,
            CreatedAtUtc.AddMinutes(1)));
    }

    [Fact]
    public void BindAgentSession_WithDifferentSessionAfterBindingRejects()
    {
        Conversation conversation = CreateConversation();
        Guid firstSessionId = Guid.NewGuid();
        conversation.BindAgentSession(firstSessionId, CreatedAtUtc.AddMinutes(1));

        Assert.Throws<InvalidOperationException>(() => conversation.BindAgentSession(
            Guid.NewGuid(),
            CreatedAtUtc.AddMinutes(2)));
        Assert.Equal(firstSessionId, conversation.AgentSessionId);
    }

    [Fact]
    public void BindAgentSession_WithSameSessionUpdatesTimestamp()
    {
        Conversation conversation = CreateConversation();
        Guid agentSessionId = Guid.NewGuid();
        conversation.BindAgentSession(agentSessionId, CreatedAtUtc.AddMinutes(1));
        DateTime updatedAtUtc = CreatedAtUtc.AddMinutes(2);

        conversation.BindAgentSession(agentSessionId, updatedAtUtc);

        Assert.Equal(agentSessionId, conversation.AgentSessionId);
        Assert.Equal(updatedAtUtc, conversation.UpdatedAtUtc);
    }

    [Fact]
    public async Task CreateHandler_UsesCurrentUserAndTimePersistsConversationAndReturnsResult()
    {
        var repository = new FakeConversationRepository();
        var handler = new CreateConversationHandler(
            repository,
            new FakeCurrentUser(UserId),
            new FixedTimeProvider(new DateTimeOffset(CreatedAtUtc)));
        using var cancellationSource = new CancellationTokenSource();

        CreateConversationResult result = await handler.HandleAsync(
            new CreateConversationCommand(),
            cancellationSource.Token);

        Assert.NotNull(repository.AddedConversation);
        Assert.Equal(UserId, repository.AddedConversation!.UserId);
        Assert.Equal(Conversation.DefaultTitle, repository.AddedConversation.Title);
        Assert.Null(repository.AddedConversation.AgentSessionId);
        Assert.Equal(CreatedAtUtc, repository.AddedConversation.CreatedAtUtc);
        Assert.Equal(CreatedAtUtc, repository.AddedConversation.UpdatedAtUtc);
        Assert.Equal(1, repository.AddCallCount);
        Assert.Equal(1, repository.SaveChangesCallCount);
        Assert.Equal(cancellationSource.Token, repository.AddCancellationToken);
        Assert.Equal(cancellationSource.Token, repository.SaveChangesCancellationToken);
        Assert.Equal(repository.AddedConversation.Id, result.Id);
        Assert.Equal(Conversation.DefaultTitle, result.Title);
        Assert.Equal(CreatedAtUtc, result.CreatedAtUtc);
        Assert.Equal(CreatedAtUtc, result.UpdatedAtUtc);
    }

    [Fact]
    public async Task ListHandler_UsesCurrentUserAndMapsSummaries()
    {
        Conversation first = Conversation.Create(UserId, "First", CreatedAtUtc);
        Conversation second = Conversation.Create(
            UserId,
            "Second",
            CreatedAtUtc.AddMinutes(1));
        var repository = new FakeConversationRepository
        {
            Conversations = [first, second],
        };
        var handler = new ListConversationsHandler(
            repository,
            new FakeCurrentUser(UserId));
        using var cancellationSource = new CancellationTokenSource();

        IReadOnlyList<ConversationSummaryResult> result = await handler.HandleAsync(
            new ListConversationsQuery(),
            cancellationSource.Token);

        Assert.Equal(UserId, repository.RequestedUserId);
        Assert.Equal(cancellationSource.Token, repository.ListCancellationToken);
        Assert.Equal(
            [
                new ConversationSummaryResult(first.Id, first.Title, first.UpdatedAtUtc),
                new ConversationSummaryResult(second.Id, second.Title, second.UpdatedAtUtc),
            ],
            result);
    }

    [Fact]
    public async Task ListHandler_WithNoConversationsReturnsEmptyList()
    {
        var repository = new FakeConversationRepository();
        var handler = new ListConversationsHandler(
            repository,
            new FakeCurrentUser(UserId));

        IReadOnlyList<ConversationSummaryResult> result = await handler.HandleAsync(
            new ListConversationsQuery(),
            CancellationToken.None);

        Assert.Empty(result);
    }

    private static Conversation CreateConversation() =>
        Conversation.Create(UserId, Conversation.DefaultTitle, CreatedAtUtc);

    private sealed class FixedTimeProvider(DateTimeOffset currentTime) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => currentTime;
    }

    private sealed class FakeCurrentUser(Guid userId) : ICurrentUser
    {
        public Guid UserId { get; } = userId;
    }

    private sealed class FakeConversationRepository : IConversationRepository
    {
        public IReadOnlyList<Conversation> Conversations { get; init; } = [];

        public Conversation? AddedConversation { get; private set; }

        public Guid RequestedUserId { get; private set; }

        public CancellationToken AddCancellationToken { get; private set; }

        public CancellationToken ListCancellationToken { get; private set; }

        public CancellationToken SaveChangesCancellationToken { get; private set; }

        public int AddCallCount { get; private set; }

        public int SaveChangesCallCount { get; private set; }

        public Task AddAsync(Conversation conversation, CancellationToken cancellationToken)
        {
            AddedConversation = conversation;
            AddCancellationToken = cancellationToken;
            AddCallCount++;
            return Task.CompletedTask;
        }

        public Task<IReadOnlyList<Conversation>> ListByUserIdAsync(
            Guid userId,
            CancellationToken cancellationToken)
        {
            RequestedUserId = userId;
            ListCancellationToken = cancellationToken;
            return Task.FromResult(Conversations);
        }

        public Task SaveChangesAsync(CancellationToken cancellationToken)
        {
            SaveChangesCancellationToken = cancellationToken;
            SaveChangesCallCount++;
            return Task.CompletedTask;
        }
    }
}
