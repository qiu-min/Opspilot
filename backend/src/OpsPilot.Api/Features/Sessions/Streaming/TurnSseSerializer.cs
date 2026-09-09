using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Http;
using OpsPilot.Application.Abstractions.AgentService;

namespace OpsPilot.Api.Features.Sessions.Streaming;

public static class TurnSseSerializer
{
    private static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    public static async Task WriteAsync(HttpResponse response, AgentTurnStreamEvent streamEvent, CancellationToken cancellationToken)
    {
         Console.WriteLine(
        $"[turn-stream][web-http-out] turnId={streamEvent.TurnId} sessionId={streamEvent.SessionId} type={streamEvent.Type} seq={streamEvent.Sequence}");
        string data = JsonSerializer.Serialize(streamEvent, streamEvent.GetType(), Options);
        string frame = $"id: {streamEvent.Sequence}\nevent: {streamEvent.Type}\ndata: {data}\n\n";
        await response.Body.WriteAsync(Encoding.UTF8.GetBytes(frame), cancellationToken);
        await response.Body.FlushAsync(cancellationToken);
    }
}
