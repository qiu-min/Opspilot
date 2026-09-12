namespace OpsPilot.Application.Sessions.GetDetail;
public sealed record GetSessionDetailResult(
    Guid Id,
    string Title,
    DateTime CreatedAtUtc,
    DateTime UpdatedAtUtc,
    IReadOnlyList<SessionHistoryItemResult> Items,
    IReadOnlyList<SessionTurnPresentationSummaryResult> TurnSummaries);
