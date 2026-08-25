using Microsoft.Extensions.DependencyInjection;
using OpsPilot.Application.AnalysisTasks.CreateAnalysisTask;

namespace OpsPilot.Application;

public static class DependencyInjection
{
    public static IServiceCollection AddApplication(this IServiceCollection services)
    {
        services.AddSingleton(TimeProvider.System);
        services.AddScoped<CreateAnalysisTaskHandler>();

        return services;
    }
}
