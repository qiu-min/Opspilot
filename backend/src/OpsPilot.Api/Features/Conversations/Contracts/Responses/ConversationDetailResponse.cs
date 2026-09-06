using System.Text.Json.Serialization;

namespace OpsPilot.Api.Features.Conversations.Contracts.Responses;

public sealed record ConversationDetailResponse(
    Guid Id,
    string Title,
    DateTime CreatedAtUtc,
    DateTime UpdatedAtUtc,
    IReadOnlyList<ConversationHistoryItemResponse> Items);

[JsonPolymorphic(TypeDiscriminatorPropertyName = "type")]
[JsonDerivedType(typeof(ConversationHistoryMessageItemResponse), "message")]
[JsonDerivedType(typeof(ConversationHistoryToolExecutionItemResponse), "tool_execution")]
public abstract record ConversationHistoryItemResponse(
    string Id,
    DateTimeOffset CreatedAtUtc);

public sealed record ConversationHistoryMessageItemResponse(
    string Id,
    string Role,
    string Text,
    DateTimeOffset CreatedAtUtc)
    : ConversationHistoryItemResponse(Id, CreatedAtUtc);

public sealed record ConversationHistoryToolExecutionItemResponse(
    string Id,
    string CallId,
    string Name,
    string Status,
    DateTimeOffset CreatedAtUtc)
    : ConversationHistoryItemResponse(Id, CreatedAtUtc);
