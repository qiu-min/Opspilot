using System.Net.Http.Json;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Serialization;
using OpsPilot.Application.Abstractions.AgentService;
using OpsPilot.Application.Exceptions;
using OpsPilot.Infrastructure.AgentService.Streaming;

namespace OpsPilot.Infrastructure.AgentService;

public sealed class AgentServiceClient(HttpClient httpClient) : IAgentSessionClient
{
    private static readonly JsonSerializerOptions JsonSerializerOptions = new(
        JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    public async Task<AgentSessionCreated> CreateSessionAsync(CancellationToken cancellationToken)
    {
        using HttpResponseMessage response = await httpClient.PostAsync("sessions", null, cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
        AgentSessionCreated? result = await response.Content.ReadFromJsonAsync<AgentSessionCreated>(JsonSerializerOptions, cancellationToken);
        return result ?? throw new HttpRequestException("Agent Service returned an empty Session response.");
    }

    public async Task<AgentSessionHistory> GetHistoryAsync(
        Guid sessionId,
        CancellationToken cancellationToken)
    {
        using HttpResponseMessage response = await httpClient.GetAsync($"sessions/{sessionId:D}/history", cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
        AgentSessionHistory? result = await response.Content.ReadFromJsonAsync<AgentSessionHistory>(JsonSerializerOptions, cancellationToken);

        return result
            ?? throw new HttpRequestException("Agent Service returned an empty history response.");
    }

    public async Task<AgentTurnResult> RunTurnAsync(
        Guid sessionId,
        AgentTurnRequest request,
        CancellationToken cancellationToken)
    {
        using HttpResponseMessage response = await httpClient.PostAsJsonAsync(
            $"sessions/{sessionId:D}/turns",
            request,
            JsonSerializerOptions,
            cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
        AgentTurnResult? result = await response.Content.ReadFromJsonAsync<AgentTurnResult>(JsonSerializerOptions, cancellationToken);

        return result
            ?? throw new HttpRequestException("Agent Service returned an empty response.");
    }

    public async IAsyncEnumerable<AgentTurnStreamEvent> StartTurnStreamAsync(
        Guid sessionId,
        AgentTurnRequest request,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        using var httpRequest = new HttpRequestMessage(
            HttpMethod.Post,
            $"sessions/{sessionId:D}/turns/stream")
        {
            Content = JsonContent.Create(request, options: JsonSerializerOptions),
        };

        using HttpResponseMessage response = await httpClient.SendAsync(
            httpRequest,
            HttpCompletionOption.ResponseHeadersRead,
            cancellationToken);

        await EnsureSuccessAsync(response, cancellationToken);

        await using Stream responseStream = await response.Content.ReadAsStreamAsync(
            cancellationToken);
        await foreach (SseFrame frame in SseReader.ReadAsync(
            responseStream,
            cancellationToken))
        {
            yield return AgentServiceStreamEventParser.Parse(frame);
        }
    }

    public async Task<AgentActiveTurnSnapshot?> GetActiveTurnAsync(Guid sessionId, CancellationToken cancellationToken)
    {
        using HttpResponseMessage response = await httpClient.GetAsync($"sessions/{sessionId:D}/active-turn", cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
        await using Stream responseStream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using JsonDocument document = await JsonDocument.ParseAsync(responseStream, cancellationToken: cancellationToken);
        JsonElement activeTurn = document.RootElement.GetProperty("activeTurn");
        return activeTurn.ValueKind == JsonValueKind.Null
            ? null
            : activeTurn.Deserialize<AgentActiveTurnSnapshot>(JsonSerializerOptions);
    }

    public async IAsyncEnumerable<AgentTurnStreamEvent> ReattachTurnStreamAsync(
        Guid turnId,
        long? afterSequence,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        string path = $"turns/{turnId:D}/stream";
        if (afterSequence is long after) path += $"?after={after}";
        using HttpResponseMessage response = await httpClient.GetAsync(path, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
        await using Stream responseStream = await response.Content.ReadAsStreamAsync(cancellationToken);
        await foreach (SseFrame frame in SseReader.ReadAsync(responseStream, cancellationToken))
            yield return AgentServiceStreamEventParser.Parse(frame);
    }

    private static async Task EnsureSuccessAsync(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        if (response.IsSuccessStatusCode) return;
        if (response.StatusCode == System.Net.HttpStatusCode.Conflict)
        {
            string responseBody = await response.Content.ReadAsStringAsync(cancellationToken);
            (string code, string message) = ParseConflict(responseBody);
            throw new ApplicationConflictException(message, code);
        }
        if (response.StatusCode == System.Net.HttpStatusCode.NotFound)
            throw new ApplicationNotFoundException("Agent Service resource was not found.");
        throw new HttpRequestException($"Agent Service returned HTTP {(int)response.StatusCode}.", null, response.StatusCode);
    }

    private static (string Code, string Message) ParseConflict(string responseBody)
    {
        try
        {
            using JsonDocument document = JsonDocument.Parse(responseBody);
            JsonElement root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
                return ("CONFLICT", "Agent Service reported a conflict.");
            string code = root.TryGetProperty("code", out JsonElement codeElement) && codeElement.ValueKind == JsonValueKind.String
                ? codeElement.GetString() ?? "CONFLICT"
                : "CONFLICT";
            string message = root.TryGetProperty("detail", out JsonElement detailElement) && detailElement.ValueKind == JsonValueKind.String
                ? detailElement.GetString() ?? "Agent Service reported a conflict."
                : root.TryGetProperty("message", out JsonElement messageElement) && messageElement.ValueKind == JsonValueKind.String
                    ? messageElement.GetString() ?? "Agent Service reported a conflict."
                    : "Agent Service reported a conflict.";
            return (string.IsNullOrWhiteSpace(code) ? "CONFLICT" : code, message);
        }
        catch (JsonException)
        {
            return ("CONFLICT", "Agent Service reported a conflict.");
        }
    }
}
