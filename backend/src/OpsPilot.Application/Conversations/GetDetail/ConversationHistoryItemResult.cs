using System.Text.Json.Serialization;

namespace OpsPilot.Application.Conversations.GetDetail;

[JsonPolymorphic(TypeDiscriminatorPropertyName = "type")]
[JsonDerivedType(typeof(ConversationHistoryMessageItemResult), "message")]
[JsonDerivedType(typeof(ConversationHistoryToolExecutionItemResult), "tool_execution")]
public abstract record ConversationHistoryItemResult(
    string Id,
    DateTimeOffset CreatedAtUtc);

public sealed record ConversationHistoryMessageItemResult(
    string Id,
    string Role,
    string Text,
    DateTimeOffset CreatedAtUtc)
    : ConversationHistoryItemResult(Id, CreatedAtUtc);

public sealed record ConversationHistoryToolExecutionItemResult(
    string Id,
    string CallId,
    string Name,
    string Status,
    DateTimeOffset CreatedAtUtc)
    : ConversationHistoryItemResult(Id, CreatedAtUtc);
