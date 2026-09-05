namespace OpsPilot.Infrastructure.AgentService.Streaming;

internal sealed record SseFrame(
    string Event,
    string Data);
