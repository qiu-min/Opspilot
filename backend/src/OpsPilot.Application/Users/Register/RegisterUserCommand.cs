namespace OpsPilot.Application.Users.Register;

public sealed record RegisterUserCommand(
    string? Email,
    string? Password);
