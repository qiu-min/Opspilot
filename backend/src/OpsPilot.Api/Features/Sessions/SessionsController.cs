using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using OpsPilot.Api.Features.Sessions.Contracts.Requests;
using OpsPilot.Api.Features.Sessions.Contracts.Responses;
using OpsPilot.Api.Features.Sessions.Streaming;
using OpsPilot.Application.Abstractions.AgentService;
using OpsPilot.Application.Sessions.Create;
using OpsPilot.Application.Sessions.GetDetail;
using OpsPilot.Application.Sessions.List;
using OpsPilot.Application.Sessions.Live;
using OpsPilot.Application.Sessions.RunTurn;
using OpsPilot.Application.Sessions.StreamTurn;

namespace OpsPilot.Api.Features.Sessions;

[ApiController]
[Route("api/sessions")]
[Authorize]
public sealed class SessionsController(
    CreateSessionHandler createSessionHandler,
    ListSessionsHandler listSessionsHandler,
    GetSessionDetailHandler getSessionDetailHandler,
    RunSessionTurnHandler runSessionTurnHandler,
    StreamSessionTurnHandler streamSessionTurnHandler,
    GetActiveSessionTurnHandler getActiveSessionTurnHandler,
    ReattachSessionTurnStreamHandler reattachSessionTurnStreamHandler,
    ILogger<SessionsController> logger) : ControllerBase
{
    [HttpPost]
    public async Task<ActionResult<CreateSessionResponse>> Create(CancellationToken cancellationToken)
    {
        CreateSessionResult result = await createSessionHandler.HandleAsync(new CreateSessionCommand(), cancellationToken);
        return StatusCode(StatusCodes.Status201Created, new CreateSessionResponse(result.Id, result.Title, result.CreatedAtUtc, result.UpdatedAtUtc));
    }

    [HttpGet]
    public async Task<ActionResult<IReadOnlyList<SessionSummaryResponse>>> List(CancellationToken cancellationToken)
    {
        IReadOnlyList<SessionSummaryResult> results = await listSessionsHandler.HandleAsync(new ListSessionsQuery(), cancellationToken);
        return Ok(results.Select(result => new SessionSummaryResponse(result.Id, result.Title, result.UpdatedAtUtc)).ToArray());
    }

    [HttpGet("{sessionId:guid}")]
    public async Task<ActionResult<SessionDetailResponse>> GetDetail(Guid sessionId, CancellationToken cancellationToken)
    {
        GetSessionDetailResult result = await getSessionDetailHandler.HandleAsync(new GetSessionDetailQuery(sessionId), cancellationToken);
        return Ok(new SessionDetailResponse(result.Id, result.Title, result.CreatedAtUtc, result.UpdatedAtUtc, result.Items.Select(MapHistoryItem).ToArray()));
    }

    [HttpPost("{sessionId:guid}/turns")]
    public async Task<ActionResult<SessionTurnResponse>> RunTurn(Guid sessionId, SessionTurnRequest request, CancellationToken cancellationToken)
    {
        RunSessionTurnResult result = await runSessionTurnHandler.HandleAsync(new RunSessionTurnCommand(sessionId, request.FileId, request.Message), cancellationToken);
        return Ok(new SessionTurnResponse(result.SessionId, result.TurnId, result.LeafId, result.Status, result.Output));
    }

    [HttpGet("{sessionId:guid}/active-turn")]
    public async Task<ActionResult<object>> GetActiveTurn(Guid sessionId, CancellationToken cancellationToken)
    {
        AgentActiveTurnSnapshot? activeTurn = await getActiveSessionTurnHandler.HandleAsync(sessionId, cancellationToken);
        return Ok(new { activeTurn });
    }

    [HttpPost("{sessionId:guid}/turns/stream")]
    public async Task StreamTurn(Guid sessionId, SessionTurnRequest request, CancellationToken cancellationToken)
    {
        await StreamEventsAsync(streamSessionTurnHandler.HandleAsync(new StreamSessionTurnCommand(sessionId, request.FileId, request.Message), cancellationToken), cancellationToken, requireStarted: true);
    }

    [HttpGet("{sessionId:guid}/turns/{turnId:guid}/stream")]
    public async Task ReattachTurn(Guid sessionId, Guid turnId, [FromQuery] long? after, CancellationToken cancellationToken)
    {
        if (after is < -1) throw new Application.Exceptions.ApplicationValidationException("after must be greater than or equal to -1.");
        await StreamEventsAsync(reattachSessionTurnStreamHandler.HandleAsync(sessionId, turnId, after, cancellationToken), cancellationToken, requireStarted: false);
    }

    private async Task StreamEventsAsync(IAsyncEnumerable<AgentTurnStreamEvent> events, CancellationToken cancellationToken, bool requireStarted)
    {
        IAsyncEnumerator<AgentTurnStreamEvent>? enumerator = null;
        bool responseStarted = false;
        try
        {
            enumerator = events.GetAsyncEnumerator(cancellationToken);
            while (await enumerator.MoveNextAsync())
            {
                AgentTurnStreamEvent streamEvent = enumerator.Current;
                if (requireStarted && !responseStarted)
                {
                    if (streamEvent is not AgentTurnStarted) throw new InvalidOperationException("Turn stream must begin with turn_started.");
                    StartSseResponse();
                    responseStarted = true;
                }
                else if (!responseStarted)
                {
                    StartSseResponse();
                    responseStarted = true;
                }
                await TurnSseSerializer.WriteAsync(Response, streamEvent, cancellationToken);
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            // Cancelling this enumerator only detaches this subscriber; it never cancels the Turn.
        }
        catch (Exception exception) when (responseStarted && !cancellationToken.IsCancellationRequested)
        {
            logger.LogError(exception, "Session Turn stream transport failed.");
        }
        finally
        {
            if (enumerator is not null) await enumerator.DisposeAsync();
            if (responseStarted && Response.HasStarted && Response.Body.CanWrite)
            {
                await Response.Body.FlushAsync(CancellationToken.None);
                await HttpContext.Response.CompleteAsync();
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
        HttpContext.Features.Get<Microsoft.AspNetCore.Http.Features.IHttpResponseBodyFeature>()?.DisableBuffering();
    }

    private static SessionHistoryItemResponse MapHistoryItem(SessionHistoryItemResult item) => item switch
    {
        SessionHistoryMessageItemResult message => new SessionHistoryMessageItemResponse(message.Id, message.Role, message.Text, message.CreatedAtUtc),
        SessionHistoryToolExecutionItemResult tool => new SessionHistoryToolExecutionItemResponse(tool.Id, tool.CallId, tool.Name, tool.Status, tool.CreatedAtUtc),
        _ => throw new InvalidOperationException($"Unsupported Session history item: {item.GetType().Name}.")
    };
}
