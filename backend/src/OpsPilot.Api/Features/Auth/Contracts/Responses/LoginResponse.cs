namespace OpsPilot.Api.Features.Auth.Contracts.Responses;

public sealed record LoginResponse(
    Guid UserId,
    string Email,
    string AccessToken,
    DateTime ExpiresAtUtc);
