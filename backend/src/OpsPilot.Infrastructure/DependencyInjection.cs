using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using OpsPilot.Application.Abstractions.AgentService;
using OpsPilot.Application.Abstractions.Files;
using OpsPilot.Application.Abstractions.Persistence;
using OpsPilot.Infrastructure.AgentService;
using OpsPilot.Infrastructure.Files;
using OpsPilot.Infrastructure.Persistence;
using OpsPilot.Infrastructure.Persistence.Repositories;

namespace OpsPilot.Infrastructure;

public static class DependencyInjection
{
    public static IServiceCollection AddInfrastructure(
        this IServiceCollection services,
        IConfiguration configuration)
    {
        var connectionString = configuration.GetConnectionString("Postgres");
        if (string.IsNullOrWhiteSpace(connectionString))
        {
            throw new InvalidOperationException(
                "Connection string 'Postgres' is not configured.");
        }

        services.AddDbContext<OpsPilotDbContext>(options =>
            options.UseNpgsql(connectionString));
        services.AddScoped<IAnalysisTaskRepository, AnalysisTaskRepository>();
        services.AddScoped<IFileAssetRepository, FileAssetRepository>();

        string? configuredAgentServiceBaseUrl = configuration[
            $"{AgentServiceOptions.SectionName}:BaseUrl"];
        if (string.IsNullOrWhiteSpace(configuredAgentServiceBaseUrl) ||
            !Uri.TryCreate(
                configuredAgentServiceBaseUrl.Trim(),
                UriKind.Absolute,
                out Uri? agentServiceBaseUri) ||
            (!string.Equals(
                    agentServiceBaseUri.Scheme,
                    Uri.UriSchemeHttp,
                    StringComparison.OrdinalIgnoreCase) &&
                !string.Equals(
                    agentServiceBaseUri.Scheme,
                    Uri.UriSchemeHttps,
                    StringComparison.OrdinalIgnoreCase)) ||
            string.IsNullOrWhiteSpace(agentServiceBaseUri.Host))
        {
            throw new InvalidOperationException(
                "Agent Service base URL is not configured correctly at AgentService:BaseUrl.");
        }

        var agentServiceOptions = new AgentServiceOptions
        {
            BaseUrl = agentServiceBaseUri.ToString(),
        };
        services.AddSingleton(agentServiceOptions);
        services.AddHttpClient<IAgentConversationClient, AgentServiceClient>(httpClient =>
        {
            httpClient.BaseAddress = agentServiceBaseUri;
        });

        string? configuredRootPath = configuration[$"{FileStorageOptions.SectionName}:RootPath"];
        string rootPath = string.IsNullOrWhiteSpace(configuredRootPath)
            ? "storage"
            : configuredRootPath;
        services.AddSingleton(new FileStorageOptions { RootPath = rootPath });
        services.AddSingleton<IFileStorage, LocalFileStorage>();

        return services;
    }
}
