using Microsoft.Extensions.DependencyInjection;
using OpsPilot.Application.Conversations.Create;
using OpsPilot.Application.Conversations.GetDetail;
using OpsPilot.Application.Conversations.List;
using OpsPilot.Application.Conversations.RunTurn;
using OpsPilot.Application.Conversations.StreamTurn;
using OpsPilot.Application.Files.GetById;
using OpsPilot.Application.Files.Upload;
using OpsPilot.Application.Users.Login;
using OpsPilot.Application.Users.Register;

namespace OpsPilot.Application;

public static class DependencyInjection
{
    public static IServiceCollection AddApplication(this IServiceCollection services)
    {
        services.AddSingleton(TimeProvider.System);
        services.AddScoped<CreateConversationHandler>();
        services.AddScoped<GetConversationDetailHandler>();
        services.AddScoped<GetFileAssetHandler>();
        services.AddScoped<ListConversationsHandler>();
        services.AddScoped<RunConversationTurnHandler>();
        services.AddScoped<StreamConversationTurnHandler>();
        services.AddScoped<UploadFileHandler>();
        services.AddScoped<LoginUserHandler>();
        services.AddScoped<RegisterUserHandler>();

        return services;
    }
}
