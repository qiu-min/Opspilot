using System.Text.Json.Serialization;

namespace OpsPilot.Application.Abstractions.AgentService;

[JsonPolymorphic(TypeDiscriminatorPropertyName = "type")]
[JsonDerivedType(typeof(AgentSessionHistoryMessageItem), "message")]
[JsonDerivedType(typeof(AgentSessionHistoryToolExecutionItem), "tool_execution")]
public abstract record AgentSessionHistoryItem(string Id, DateTimeOffset CreatedAt);

public sealed record AgentSessionHistoryMessageItem(string Id, string Role, string Text, DateTimeOffset CreatedAt)
    : AgentSessionHistoryItem(Id, CreatedAt);

public sealed record AgentSessionHistoryToolExecutionItem(string Id, string CallId, string Name, string Status, DateTimeOffset CreatedAt)
    : AgentSessionHistoryItem(Id, CreatedAt);
