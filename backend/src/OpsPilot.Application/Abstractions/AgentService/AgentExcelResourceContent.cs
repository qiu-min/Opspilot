namespace OpsPilot.Application.Abstractions.AgentService;

/// <summary>Represents an Agent Service workbook stream owned by the current request.</summary>
public sealed record AgentExcelResourceContent(
    Stream Content,
    string FileName,
    string ContentType);
