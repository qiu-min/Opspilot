using Microsoft.Extensions.DependencyInjection;
using OpsPilot.Application.Files.GetById;
using OpsPilot.Application.Files.Upload;
using OpsPilot.Application.Sessions.Create;
using OpsPilot.Application.Sessions.GetDetail;
using OpsPilot.Application.Sessions.List;
using OpsPilot.Application.Sessions.Live;
using OpsPilot.Application.Sessions.RunTurn;
using OpsPilot.Application.Sessions.StreamTurn;
using OpsPilot.Application.Users.Login;
using OpsPilot.Application.Users.Register;

namespace OpsPilot.Application;

public static class DependencyInjection
{
    public static IServiceCollection AddApplication(this IServiceCollection services)
    {
        services.AddSingleton(TimeProvider.System);
        services.AddScoped<CreateSessionHandler>();
        services.AddScoped<GetSessionDetailHandler>();
        services.AddScoped<GetFileAssetHandler>();
        services.AddScoped<ListSessionsHandler>();
        services.AddScoped<RunSessionTurnHandler>();
        services.AddScoped<StreamSessionTurnHandler>();
        services.AddScoped<GetActiveSessionTurnHandler>();
        services.AddScoped<ReattachSessionTurnStreamHandler>();
        services.AddScoped<UploadFileHandler>();
        services.AddScoped<LoginUserHandler>();
        services.AddScoped<RegisterUserHandler>();

        return services;
    }
}
