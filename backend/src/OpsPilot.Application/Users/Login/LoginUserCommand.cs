namespace OpsPilot.Application.Users.Login;

public sealed record LoginUserCommand(
    string? Email,
    string? Password);
