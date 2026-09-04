using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using OpsPilot.Api.Features.Conversations.Contracts.Requests;
using OpsPilot.Api.Features.Conversations.Contracts.Responses;
using OpsPilot.Application.Conversations.Create;
using OpsPilot.Application.Conversations.List;
using OpsPilot.Application.Conversations.RunTurn;

namespace OpsPilot.Api.Features.Conversations;

[ApiController]
[Route("api/conversations")]
[Authorize]
public sealed class ConversationsController(
    CreateConversationHandler createConversationHandler,
    ListConversationsHandler listConversationsHandler,
    RunConversationTurnHandler runConversationTurnHandler) : ControllerBase
{
    [HttpPost]
    [ProducesResponseType(typeof(CreateConversationResponse), StatusCodes.Status201Created)]
    public async Task<ActionResult<CreateConversationResponse>> Create(
        CancellationToken cancellationToken)
    {
        CreateConversationResult result = await createConversationHandler.HandleAsync(
            new CreateConversationCommand(),
            cancellationToken);

        return StatusCode(
            StatusCodes.Status201Created,
            new CreateConversationResponse(
                result.Id,
                result.Title,
                result.CreatedAtUtc,
                result.UpdatedAtUtc));
    }

    [HttpGet]
    [ProducesResponseType(typeof(IReadOnlyList<ConversationSummaryResponse>), StatusCodes.Status200OK)]
    public async Task<ActionResult<IReadOnlyList<ConversationSummaryResponse>>> List(
        CancellationToken cancellationToken)
    {
        IReadOnlyList<ConversationSummaryResult> results =
            await listConversationsHandler.HandleAsync(
                new ListConversationsQuery(),
                cancellationToken);

        return Ok(results
            .Select(result => new ConversationSummaryResponse(
                result.Id,
                result.Title,
                result.UpdatedAtUtc))
            .ToArray());
    }

    [HttpPost("turns")]
    [ProducesResponseType(typeof(ConversationTurnResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<ConversationTurnResponse>> RunTurn(
        ConversationTurnRequest request,
        CancellationToken cancellationToken)
    {
        RunConversationTurnResult result = await runConversationTurnHandler.HandleAsync(
            new RunConversationTurnCommand(request.SessionId, request.FileId, request.Message),
            cancellationToken);

        return Ok(new ConversationTurnResponse(
            result.SessionId,
            result.LeafId,
            result.Status,
            result.Output));
    }
}
