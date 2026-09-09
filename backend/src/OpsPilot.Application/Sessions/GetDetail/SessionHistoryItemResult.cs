using System.Text.Json.Serialization;

namespace OpsPilot.Application.Sessions.GetDetail;

[JsonPolymorphic(TypeDiscriminatorPropertyName = "type")]
[JsonDerivedType(typeof(SessionHistoryMessageItemResult), "message")]
[JsonDerivedType(typeof(SessionHistoryToolExecutionItemResult), "tool_execution")]
public abstract record SessionHistoryItemResult(string Id, DateTimeOffset CreatedAtUtc);
public sealed record SessionHistoryMessageItemResult(string Id, string Role, string Text, DateTimeOffset CreatedAtUtc) : SessionHistoryItemResult(Id, CreatedAtUtc);
public sealed record SessionHistoryToolExecutionItemResult(string Id, string CallId, string Name, string Status, DateTimeOffset CreatedAtUtc) : SessionHistoryItemResult(Id, CreatedAtUtc);
