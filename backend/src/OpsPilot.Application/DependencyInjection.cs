using Microsoft.Extensions.DependencyInjection;
using OpsPilot.Application.Conversations.RunTurn;
using OpsPilot.Application.Files.GetById;
using OpsPilot.Application.Files.Upload;
using OpsPilot.Application.Users.Register;

namespace OpsPilot.Application;

public static class DependencyInjection
{
    public static IServiceCollection AddApplication(this IServiceCollection services)
    {
        services.AddSingleton(TimeProvider.System);
        services.AddScoped<GetFileAssetHandler>();
        services.AddScoped<RunConversationTurnHandler>();
        services.AddScoped<UploadFileHandler>();
        services.AddScoped<RegisterUserHandler>();

        return services;
    }
}
