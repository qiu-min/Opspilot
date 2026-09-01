namespace OpsPilot.Infrastructure.AgentService;

public sealed class AgentServiceOptions
{
    public const string SectionName = "AgentService";

    public string BaseUrl { get; init; } = string.Empty;
}
