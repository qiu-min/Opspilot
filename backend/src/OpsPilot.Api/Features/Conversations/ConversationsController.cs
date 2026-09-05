using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using OpsPilot.Api.Features.Conversations.Contracts.Requests;
using OpsPilot.Api.Features.Conversations.Contracts.Responses;
using OpsPilot.Api.Features.Conversations.Streaming;
using OpsPilot.Application.Conversations.Create;
using OpsPilot.Application.Conversations.GetDetail;
using OpsPilot.Application.Conversations.List;
using OpsPilot.Application.Conversations.RunTurn;
using OpsPilot.Application.Conversations.StreamTurn;

namespace OpsPilot.Api.Features.Conversations;

[ApiController]
[Route("api/conversations")]
[Authorize]
public sealed class ConversationsController(
    CreateConversationHandler createConversationHandler,
    ListConversationsHandler listConversationsHandler,
    GetConversationDetailHandler getConversationDetailHandler,
    RunConversationTurnHandler runConversationTurnHandler,
    StreamConversationTurnHandler streamConversationTurnHandler,
    ILogger<ConversationsController> logger) : ControllerBase
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

    [HttpGet("{conversationId:guid}")]
    [ProducesResponseType(typeof(ConversationDetailResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<ConversationDetailResponse>> GetDetail(
        Guid conversationId,
        CancellationToken cancellationToken)
    {
        GetConversationDetailResult result = await getConversationDetailHandler.HandleAsync(
            new GetConversationDetailQuery(conversationId),
            cancellationToken);

        return Ok(new ConversationDetailResponse(
            result.Id,
            result.Title,
            result.CreatedAtUtc,
            result.UpdatedAtUtc,
            result.Items
                .Select(item => new ConversationHistoryItemResponse(
                    item.Type,
                    item.Id,
                    item.Role,
                    item.Text,
                    item.CreatedAtUtc))
                .ToArray()));
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
    public IActionResult RejectTurnWithoutConversationId() => NotFound();

    [HttpPost("{conversationId:guid}/turns")]
    [ProducesResponseType(typeof(ConversationTurnResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<ConversationTurnResponse>> RunTurn(
        Guid conversationId,
        ConversationTurnRequest request,
        CancellationToken cancellationToken)
    {
        RunConversationTurnResult result = await runConversationTurnHandler.HandleAsync(
            new RunConversationTurnCommand(conversationId, request.FileId, request.Message),
            cancellationToken);

        return Ok(new ConversationTurnResponse(
            result.ConversationId,
            result.LeafId,
            result.Status,
            result.Output));
    }

    [HttpPost("{conversationId:guid}/turns/stream")]
    public async Task StreamTurn(
        Guid conversationId,
        ConversationTurnRequest request)
    {
        CancellationToken cancellationToken = HttpContext.RequestAborted;
        IAsyncEnumerator<ConversationStreamEvent>? enumerator = null;
        bool sseStarted = false;
        bool terminalEventWritten = false;

        try
        {
            enumerator = streamConversationTurnHandler
                .HandleAsync(
                    new StreamConversationTurnCommand(
                        conversationId,
                        request.FileId,
                        request.Message),
                    cancellationToken)
                .GetAsyncEnumerator(cancellationToken);

            if (!await enumerator.MoveNextAsync())
            {
                throw new InvalidOperationException(
                    "Conversation stream did not produce a response-started event.");
            }

            ConversationStreamEvent firstEvent = enumerator.Current;
            if (firstEvent is not ConversationStreamEvent.ResponseStarted)
            {
                throw new InvalidOperationException(
                    "Conversation stream did not begin with a response-started event.");
            }

            StartSseResponse();
            sseStarted = true;
            await ConversationSseSerializer.WriteAsync(
                Response,
                firstEvent,
                cancellationToken);

            while (await enumerator.MoveNextAsync())
            {
                ConversationStreamEvent streamEvent = enumerator.Current;
                await ConversationSseSerializer.WriteAsync(
                    Response,
                    streamEvent,
                    cancellationToken);

                if (streamEvent is ConversationStreamEvent.ResponseCompleted
                    or ConversationStreamEvent.Error)
                {
                    terminalEventWritten = true;
                    break;
                }
            }

            if (!terminalEventWritten)
            {
                throw new InvalidOperationException(
                    "Conversation stream ended without a terminal event.");
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
        catch (Exception exception)
        {
            if (!sseStarted)
            {
                throw;
            }

            logger.LogError(
                exception,
                "Conversation streaming failed after SSE response started for {ConversationId}",
                conversationId);
            await TryWriteGenericErrorAsync(cancellationToken);
        }
        finally
        {
            if (enumerator is not null)
            {
                try
                {
                    await enumerator.DisposeAsync();
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                }
            }
        }
    }

    private void StartSseResponse()
    {
        Response.StatusCode = StatusCodes.Status200OK;
        Response.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-cache, no-transform";
        Response.Headers.Connection = "keep-alive";
        Response.Headers["X-Accel-Buffering"] = "no";
        HttpContext.Features.Get<Microsoft.AspNetCore.Http.Features.IHttpResponseBodyFeature>()
            ?.DisableBuffering();
    }

    private async Task TryWriteGenericErrorAsync(CancellationToken cancellationToken)
    {
        if (!Response.Body.CanWrite)
        {
            return;
        }

        try
        {
            await ConversationSseSerializer.WriteAsync(
                Response,
                new ConversationStreamEvent.Error("Internal server error."),
                cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
        catch
        {
        }
    }
}
