using System.Text.Json;
using OpsPilot.Api.Features.Sessions.Contracts.Responses;
using OpsPilot.Application.Abstractions.AgentService;

namespace OpsPilot.IntegrationTests;

public sealed class SessionTraceResponseTests
{
    [Fact]
    public void Mapper_PreservesPolymorphicSpanDataForApiSerialization()
    {
        Guid turnId = Guid.Parse("66666666-6666-4666-8666-666666666666");
        Guid sessionId = Guid.Parse("55555555-5555-4555-8555-555555555555");
        AgentTurnTrace trace = new(
            turnId,
            sessionId,
            "completed",
            DateTimeOffset.Parse("2026-09-09T12:00:00Z"),
            DateTimeOffset.Parse("2026-09-09T12:00:05Z"),
            5000,
            [
                new AgentModelTraceSpan(
                    "model:model-call-A",
                    1,
                    "completed",
                    1,
                    2,
                    DateTimeOffset.Parse("2026-09-09T12:00:01Z"),
                    DateTimeOffset.Parse("2026-09-09T12:00:02Z"),
                    1000,
                    "model-call-A",
                    new AgentModelTraceUsage(10, 20, 30))
                {
                    Retries =
                    [
                        new AgentModelRetryTrace(
                            1,
                            2,
                            500,
                            new AgentModelTraceError(
                                "rate_limit",
                                "MODEL_RATE_LIMIT",
                                "Model provider rate limit exceeded.",
                                true,
                                429,
                                "provider_rate_limit"),
                            DateTimeOffset.Parse("2026-09-09T12:00:00.500Z")),
                    ],
                },
                new AgentToolTraceSpan(
                    "tool:call-1:attempt:1",
                    1,
                    "error",
                    3,
                    4,
                    DateTimeOffset.Parse("2026-09-09T12:00:03Z"),
                    DateTimeOffset.Parse("2026-09-09T12:00:04Z"),
                    1000,
                    "call-1",
                    "lookup",
                    DateTimeOffset.Parse("2026-09-09T12:00:02Z"),
                    true),
                new AgentCompactionTraceSpan(
                    "compaction:5",
                    1,
                    "completed",
                    5,
                    6,
                    DateTimeOffset.Parse("2026-09-09T12:00:03Z"),
                    DateTimeOffset.Parse("2026-09-09T12:00:04Z"),
                    1000,
                    "entry-1",
                    "leaf-1"),
            ]);

        SessionTurnTraceResponse response = SessionTraceResponseMapper.Map(trace);
        using JsonDocument document = JsonDocument.Parse(JsonSerializer.Serialize(
            response,
            new JsonSerializerOptions(JsonSerializerDefaults.Web)));
        JsonElement[] spans = document.RootElement.GetProperty("spans").EnumerateArray().ToArray();

        Assert.Equal("model", spans[0].GetProperty("kind").GetString());
        Assert.Equal(30, spans[0].GetProperty("usage").GetProperty("totalTokens").GetInt32());
        Assert.Equal(JsonValueKind.Null, spans[0].GetProperty("error").ValueKind);
        JsonElement retry = Assert.Single(spans[0].GetProperty("retries").EnumerateArray());
        Assert.Equal(1, retry.GetProperty("failedAttempt").GetInt32());
        Assert.Equal(2, retry.GetProperty("nextAttempt").GetInt32());
        Assert.Equal("MODEL_RATE_LIMIT", retry.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal(429, retry.GetProperty("error").GetProperty("statusCode").GetInt32());
        Assert.Equal("tool", spans[1].GetProperty("kind").GetString());
        Assert.True(spans[1].GetProperty("isError").GetBoolean());
        Assert.Equal("compaction", spans[2].GetProperty("kind").GetString());
        Assert.Equal("entry-1", spans[2].GetProperty("entryId").GetString());
        Assert.Equal("leaf-1", spans[2].GetProperty("sessionLeafId").GetString());
    }

    [Fact]
    public void Mapper_PreservesFinalModelFailure()
    {
        AgentTurnTrace trace = new(
            Guid.Parse("66666666-6666-4666-8666-666666666666"),
            Guid.Parse("55555555-5555-4555-8555-555555555555"),
            "failed",
            null,
            null,
            null,
            [
                new AgentModelTraceSpan(
                    "model:model-call-failed",
                    3,
                    "error",
                    10,
                    11,
                    null,
                    null,
                    null,
                    "model-call-failed",
                    null,
                    new AgentModelTraceError(
                        "server_error",
                        "MODEL_SERVER_ERROR",
                        "Model provider failed.",
                        true,
                        503,
                        "provider_unavailable")),
            ]);

        SessionTurnTraceResponse response = SessionTraceResponseMapper.Map(trace);
        using JsonDocument document = JsonDocument.Parse(JsonSerializer.Serialize(
            response,
            new JsonSerializerOptions(JsonSerializerDefaults.Web)));
        JsonElement model = Assert.Single(document.RootElement.GetProperty("spans").EnumerateArray());

        Assert.Equal("error", model.GetProperty("status").GetString());
        Assert.Equal("server_error", model.GetProperty("error").GetProperty("kind").GetString());
        Assert.Equal(503, model.GetProperty("error").GetProperty("statusCode").GetInt32());
        Assert.Empty(model.GetProperty("retries").EnumerateArray());
    }
}
