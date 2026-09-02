namespace OpsPilot.Application.Users.Login;

public sealed record LoginUserResult(
    Guid UserId,
    string Email,
    string AccessToken,
    DateTime ExpiresAtUtc);
