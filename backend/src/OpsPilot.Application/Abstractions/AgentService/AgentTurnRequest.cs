namespace OpsPilot.Application.Abstractions.AgentService;

public sealed record AgentTurnRequest(string Message, AgentExcelResource? ExcelResource);
