namespace OpsPilot.Application.Abstractions.Security;

public sealed record AccessTokenResult(
    string Token,
    DateTime ExpiresAtUtc);
