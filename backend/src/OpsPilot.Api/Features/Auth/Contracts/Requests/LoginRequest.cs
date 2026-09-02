namespace OpsPilot.Api.Features.Auth.Contracts.Requests;

public sealed record LoginRequest(
    string? Email,
    string? Password);
