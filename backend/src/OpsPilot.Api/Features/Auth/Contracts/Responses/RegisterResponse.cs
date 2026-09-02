namespace OpsPilot.Api.Features.Auth.Contracts.Responses;

public sealed record RegisterResponse(
    Guid Id,
    string Email,
    DateTime CreatedAtUtc);
