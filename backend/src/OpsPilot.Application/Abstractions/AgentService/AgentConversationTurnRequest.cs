namespace OpsPilot.Application.Abstractions.AgentService;

public sealed record AgentConversationTurnRequest(
    Guid? SessionId,
    string Message,
    AgentExcelResource? ExcelResource);
