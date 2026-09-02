namespace OpsPilot.Api.Features.Auth.Contracts.Requests;

public sealed record RegisterRequest(
    string? Email,
    string? Password);
