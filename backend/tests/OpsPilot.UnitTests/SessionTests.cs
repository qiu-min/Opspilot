using OpsPilot.Domain.Sessions;

namespace OpsPilot.UnitTests;

public sealed class SessionTests
{
    [Fact]
    public void Create_UsesAgentServiceIdentityAndDefaultMetadata()
    {
        Guid sessionId = Guid.Parse("11111111-1111-4111-8111-111111111111");
        Guid userId = Guid.Parse("22222222-2222-4222-8222-222222222222");
        DateTime created = new(2026, 9, 9, 12, 0, 0, DateTimeKind.Utc);

        Session session = Session.Create(sessionId, userId, Session.DefaultTitle, created);

        Assert.Equal(sessionId, session.Id);
        Assert.Equal(userId, session.UserId);
        Assert.Equal(Session.DefaultTitle, session.Title);
        Assert.Equal(created, session.CreatedAtUtc);
        Assert.Equal(created, session.UpdatedAtUtc);
    }

    [Fact]
    public void Touch_UpdatesMetadataWithoutAnAgentSessionBinding()
    {
        Session session = Session.Create(Guid.NewGuid(), Guid.NewGuid(), Session.DefaultTitle, DateTime.UtcNow);
        DateTime updated = session.CreatedAtUtc.AddMinutes(1);
        session.Touch(updated);
        Assert.Equal(updated, session.UpdatedAtUtc);
    }
}
