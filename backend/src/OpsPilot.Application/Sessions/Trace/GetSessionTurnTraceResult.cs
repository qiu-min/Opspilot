using OpsPilot.Application.Abstractions.AgentService;

namespace OpsPilot.Application.Sessions.Trace;

public sealed record GetSessionTurnTraceResult(AgentTurnTrace Trace);
