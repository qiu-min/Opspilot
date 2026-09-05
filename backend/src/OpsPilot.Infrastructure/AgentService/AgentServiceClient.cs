using System.Net.Http.Json;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Serialization;
using OpsPilot.Application.Abstractions.AgentService;
using OpsPilot.Infrastructure.AgentService.Streaming;

namespace OpsPilot.Infrastructure.AgentService;

public sealed class AgentServiceClient(HttpClient httpClient) : IAgentConversationClient
{
    private static readonly JsonSerializerOptions JsonSerializerOptions = new(
        JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    public async Task<AgentConversationHistory> GetHistoryAsync(
        Guid sessionId,
        CancellationToken cancellationToken)
    {
        using HttpResponseMessage response = await httpClient.GetAsync(
            $"sessions/{sessionId:D}/history",
            cancellationToken);

        if (!response.IsSuccessStatusCode)
        {
            throw new HttpRequestException(
                $"Agent Service returned HTTP {(int)response.StatusCode}.");
        }

        AgentConversationHistory? result = await response.Content.ReadFromJsonAsync<
            AgentConversationHistory>(
            JsonSerializerOptions,
            cancellationToken);

        return result
            ?? throw new HttpRequestException("Agent Service returned an empty history response.");
    }

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

    public async IAsyncEnumerable<AgentServiceStreamEvent> StreamTurnAsync(
        AgentConversationTurnRequest request,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        using var httpRequest = new HttpRequestMessage(
            HttpMethod.Post,
            "conversations/turns/stream")
        {
            Content = JsonContent.Create(request, options: JsonSerializerOptions),
        };

        using HttpResponseMessage response = await httpClient.SendAsync(
            httpRequest,
            HttpCompletionOption.ResponseHeadersRead,
            cancellationToken);

        if (!response.IsSuccessStatusCode)
        {
            throw new HttpRequestException(
                $"Agent Service returned HTTP {(int)response.StatusCode}.");
        }

        await using Stream responseStream = await response.Content.ReadAsStreamAsync(
            cancellationToken);
        await foreach (SseFrame frame in SseReader.ReadAsync(
            responseStream,
            cancellationToken))
        {
            yield return AgentServiceStreamEventParser.Parse(frame);
        }
    }
}
