using OpsPilot.Application.Abstractions.AgentService;

namespace OpsPilot.Api.Features.Sessions.Contracts.Responses;

public static class SessionTraceResponseMapper
{
    public static SessionTurnTraceResponse Map(AgentTurnTrace trace) =>
        new(
            trace.TurnId,
            trace.SessionId,
            trace.Status,
            trace.StartedAt,
            trace.EndedAt,
            trace.DurationMs,
            trace.Spans.Select(MapSpan).ToArray());

    private static SessionTraceSpanResponse MapSpan(AgentTraceSpan span) => span switch
    {
        AgentModelTraceSpan model => new SessionModelTraceSpanResponse(
            model.Id,
            model.Attempt,
            model.Status,
            model.StartSequence,
            model.EndSequence,
            model.StartedAt,
            model.EndedAt,
            model.DurationMs,
            model.ModelCallId,
            model.Usage is null
                ? null
                : new SessionTraceUsageResponse(
                    model.Usage.InputTokens,
                    model.Usage.OutputTokens,
                    model.Usage.TotalTokens)),
        AgentToolTraceSpan tool => new SessionToolTraceSpanResponse(
            tool.Id,
            tool.Attempt,
            tool.Status,
            tool.StartSequence,
            tool.EndSequence,
            tool.StartedAt,
            tool.EndedAt,
            tool.DurationMs,
            tool.CallId,
            tool.Name,
            tool.RequestedAt,
            tool.IsError),
        AgentCompactionTraceSpan compaction => new SessionCompactionTraceSpanResponse(
            compaction.Id,
            compaction.Attempt,
            compaction.Status,
            compaction.StartSequence,
            compaction.EndSequence,
            compaction.StartedAt,
            compaction.EndedAt,
            compaction.DurationMs,
            compaction.EntryId,
            compaction.SessionLeafId),
        _ => throw new InvalidOperationException(
            $"Unsupported Agent Service trace span: {span.GetType().Name}.")
    };
}
