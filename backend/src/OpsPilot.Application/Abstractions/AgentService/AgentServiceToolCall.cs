namespace OpsPilot.Application.Abstractions.AgentService;

public sealed record AgentServiceToolCall(
    string CallId,
    string Name,
    string ArgumentsJson);
