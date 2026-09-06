using System.Text.Json.Serialization;

namespace OpsPilot.Application.Abstractions.AgentService;

[JsonPolymorphic(TypeDiscriminatorPropertyName = "type")]
[JsonDerivedType(typeof(AgentConversationHistoryMessageItem), "message")]
[JsonDerivedType(typeof(AgentConversationHistoryToolExecutionItem), "tool_execution")]
public abstract record AgentConversationHistoryItem(
    string Id,
    DateTimeOffset CreatedAt);

public sealed record AgentConversationHistoryMessageItem(
    string Id,
    string Role,
    string Text,
    DateTimeOffset CreatedAt)
    : AgentConversationHistoryItem(Id, CreatedAt);

public sealed record AgentConversationHistoryToolExecutionItem(
    string Id,
    string CallId,
    string Name,
    string Status,
    DateTimeOffset CreatedAt)
    : AgentConversationHistoryItem(Id, CreatedAt);
