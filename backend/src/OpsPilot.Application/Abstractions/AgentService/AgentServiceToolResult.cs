namespace OpsPilot.Application.Abstractions.AgentService;

public sealed record AgentServiceToolResult(
    string CallId,
    string Name,
    IReadOnlyList<string> TextContent,
    bool IsError,
    string? DetailsJson = null);
