namespace OpsPilot.Application.Sessions.Create;
public sealed record CreateSessionResult(Guid Id, string Title, DateTime CreatedAtUtc, DateTime UpdatedAtUtc);
