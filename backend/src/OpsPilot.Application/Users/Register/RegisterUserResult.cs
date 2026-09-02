namespace OpsPilot.Application.Users.Register;

public sealed record RegisterUserResult(
    Guid Id,
    string Email,
    DateTime CreatedAtUtc);
