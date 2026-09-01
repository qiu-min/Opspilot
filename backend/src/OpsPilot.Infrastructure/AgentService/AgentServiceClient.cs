using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using OpsPilot.Application.Abstractions.AgentService;

namespace OpsPilot.Infrastructure.AgentService;

public sealed class AgentServiceClient(HttpClient httpClient) : IAgentConversationClient
{
    private static readonly JsonSerializerOptions JsonSerializerOptions = new(
        JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    public async Task<AgentConversationTurnResult> RunTurnAsync(
        AgentConversationTurnRequest request,
        CancellationToken cancellationToken)
    {
        using HttpResponseMessage response = await httpClient.PostAsJsonAsync(
            "conversations/turns",
            request,
            JsonSerializerOptions,
            cancellationToken);

        if (!response.IsSuccessStatusCode)
        {
            throw new HttpRequestException(
                $"Agent Service returned HTTP {(int)response.StatusCode}.");
        }

        AgentConversationTurnResult? result = await response.Content.ReadFromJsonAsync<
            AgentConversationTurnResult>(
            JsonSerializerOptions,
            cancellationToken);

        return result
            ?? throw new HttpRequestException("Agent Service returned an empty response.");
    }
}
