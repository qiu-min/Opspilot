using Microsoft.Extensions.DependencyInjection;
using OpsPilot.Application.AnalysisTasks.Create;
using OpsPilot.Application.Files.Upload;

namespace OpsPilot.Application;

public static class DependencyInjection
{
    public static IServiceCollection AddApplication(this IServiceCollection services)
    {
        services.AddSingleton(TimeProvider.System);
        services.AddScoped<CreateAnalysisTaskHandler>();
        services.AddScoped<UploadFileHandler>();

        return services;
    }
}
