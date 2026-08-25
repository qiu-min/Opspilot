using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using OpsPilot.Application.Abstractions.Files;
using OpsPilot.Application.Abstractions.Persistence;
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

        string? configuredRootPath = configuration[$"{FileStorageOptions.SectionName}:RootPath"];
        string rootPath = string.IsNullOrWhiteSpace(configuredRootPath)
            ? "storage"
            : configuredRootPath;
        services.AddSingleton(new FileStorageOptions { RootPath = rootPath });
        services.AddSingleton<IFileStorage, LocalFileStorage>();

        return services;
    }
}
