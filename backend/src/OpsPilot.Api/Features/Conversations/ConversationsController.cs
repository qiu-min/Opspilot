using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using OpsPilot.Api.Features.Conversations.Contracts.Requests;
using OpsPilot.Api.Features.Conversations.Contracts.Responses;
using OpsPilot.Application.Conversations.RunTurn;

namespace OpsPilot.Api.Features.Conversations;

[ApiController]
[Route("api/conversations")]
[Authorize]
public sealed class ConversationsController(
    RunConversationTurnHandler runConversationTurnHandler) : ControllerBase
{
    [HttpPost("turns")]
    [ProducesResponseType(typeof(ConversationTurnResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<ConversationTurnResponse>> RunTurn(
        ConversationTurnRequest request,
        CancellationToken cancellationToken)
    {
        RunConversationTurnResult? result = await runConversationTurnHandler.HandleAsync(
            new RunConversationTurnCommand(request.SessionId, request.FileId, request.Message),
            cancellationToken);

        if (result is null)
        {
            return NotFound();
        }

        return Ok(new ConversationTurnResponse(
            result.SessionId,
            result.LeafId,
            result.Status,
            result.Output));
    }
}
