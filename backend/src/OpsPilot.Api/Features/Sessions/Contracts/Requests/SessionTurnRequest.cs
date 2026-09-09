namespace OpsPilot.Api.Features.Sessions.Contracts.Requests;
public sealed record SessionTurnRequest(Guid? FileId, string Message);
