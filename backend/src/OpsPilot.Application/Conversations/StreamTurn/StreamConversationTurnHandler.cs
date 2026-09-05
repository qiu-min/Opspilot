using System.Runtime.CompilerServices;
using OpsPilot.Application.Abstractions.AgentService;
using OpsPilot.Application.Abstractions.Persistence;
using OpsPilot.Application.Abstractions.Security;
using OpsPilot.Application.Exceptions;
using OpsPilot.Application.Files.GetById;
using OpsPilot.Domain.Conversations;

namespace OpsPilot.Application.Conversations.StreamTurn;

public sealed class StreamConversationTurnHandler(
    GetFileAssetHandler getFileAssetHandler,
    IConversationRepository conversationRepository,
    ICurrentUser currentUser,
    TimeProvider timeProvider,
    IAgentConversationClient agentConversationClient)
{
    public async IAsyncEnumerable<ConversationStreamEvent> HandleAsync(
        StreamConversationTurnCommand command,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(command.Message))
        {
            throw new ApplicationValidationException("Message cannot be empty.");
        }

        Conversation? conversation = await conversationRepository.GetByIdAndUserIdAsync(
            command.ConversationId,
            currentUser.UserId,
            cancellationToken);
        if (conversation is null)
        {
            throw new ApplicationNotFoundException("Conversation not found.");
        }

        AgentExcelResource? excelResource = null;
        if (command.FileId is Guid fileId)
        {
            GetFileAssetResult fileAsset = await getFileAssetHandler.HandleAsync(
                new GetFileAssetQuery(fileId),
                cancellationToken);

            excelResource = new AgentExcelResource(fileAsset.Id, fileAsset.StoragePath);
        }

        AgentConversationTurnRequest request = new(
            conversation.AgentSessionId,
            command.Message,
            excelResource);
        Guid? resolvedSessionId = conversation.AgentSessionId;
        bool sessionReadyObserved = false;
        bool terminalEventObserved = false;
        bool thinkingActive = false;
        bool assistantMessageVisible = false;

        await foreach (AgentServiceStreamEvent agentEvent in agentConversationClient.StreamTurnAsync(
            request,
            cancellationToken))
        {
            if (!sessionReadyObserved && agentEvent is not AgentServiceStreamEvent.SessionReady)
            {
                throw new InvalidOperationException(
                    "Agent Service stream must begin with a session-ready event.");
            }

            switch (agentEvent)
            {
                case AgentServiceStreamEvent.SessionReady sessionReady:
                    if (sessionReadyObserved)
                    {
                        throw new InvalidOperationException(
                            "Agent Service returned more than one session-ready event.");
                    }

                    if (resolvedSessionId is Guid existingSessionId)
                    {
                        EnsureSessionMatches(existingSessionId, sessionReady.SessionId);
                    }

                    else
                    {
                        conversation.BindAgentSession(
                            sessionReady.SessionId,
                            timeProvider.GetUtcNow().UtcDateTime);
                        await conversationRepository.SaveChangesAsync(cancellationToken);
                        resolvedSessionId = sessionReady.SessionId;
                    }

                    sessionReadyObserved = true;
                    yield return new ConversationStreamEvent.ResponseStarted();
                    break;

                case AgentServiceStreamEvent.MessageStarted messageStarted
                    when messageStarted.Role == "assistant":
                    assistantMessageVisible = false;
                    break;

                case AgentServiceStreamEvent.ThinkingDelta:
                    if (!thinkingActive)
                    {
                        thinkingActive = true;
                        yield return new ConversationStreamEvent.AssistantThinkingStarted();
                    }

                    break;

                case AgentServiceStreamEvent.TextDelta textDelta:
                    if (thinkingActive)
                    {
                        thinkingActive = false;
                        yield return new ConversationStreamEvent.AssistantThinkingCompleted();
                    }

                    if (!assistantMessageVisible)
                    {
                        assistantMessageVisible = true;
                        yield return new ConversationStreamEvent.AssistantMessageStarted();
                    }

                    yield return new ConversationStreamEvent.AssistantTextDelta(textDelta.Delta);
                    break;

                case AgentServiceStreamEvent.MessageCompleted messageCompleted
                    when messageCompleted.Role == "assistant":
                    if (thinkingActive)
                    {
                        thinkingActive = false;
                        yield return new ConversationStreamEvent.AssistantThinkingCompleted();
                    }

                    if (assistantMessageVisible)
                    {
                        assistantMessageVisible = false;
                        yield return new ConversationStreamEvent.AssistantMessageCompleted();
                    }

                    break;

                case AgentServiceStreamEvent.ToolExecutionStarted toolStarted:
                    yield return new ConversationStreamEvent.ToolExecutionStarted(
                        toolStarted.ToolCall.CallId,
                        toolStarted.ToolCall.Name);
                    break;

                case AgentServiceStreamEvent.ToolExecutionCompleted toolCompleted:
                    yield return new ConversationStreamEvent.ToolExecutionCompleted(
                        toolCompleted.ToolCall.CallId,
                        toolCompleted.ToolCall.Name,
                        toolCompleted.Result.IsError);
                    break;

                case AgentServiceStreamEvent.Usage usage:
                    yield return new ConversationStreamEvent.Usage(
                        usage.InputTokens,
                        usage.OutputTokens,
                        usage.TotalTokens);
                    break;

                case AgentServiceStreamEvent.CompactionStarted compactionStarted:
                    yield return new ConversationStreamEvent.ContextCompactionStarted(
                        compactionStarted.Reason);
                    break;

                case AgentServiceStreamEvent.CompactionCompleted compactionCompleted:
                    yield return new ConversationStreamEvent.ContextCompactionCompleted(
                        compactionCompleted.Reason,
                        compactionCompleted.Aborted,
                        compactionCompleted.ErrorMessage is not null,
                        compactionCompleted.WillRetry);
                    break;

                case AgentServiceStreamEvent.Done done:
                    if (!sessionReadyObserved)
                    {
                        throw new InvalidOperationException(
                            "Agent Service completed the stream before session-ready.");
                    }

                    EnsureResolvedSessionMatches(resolvedSessionId, done.SessionId);
                    conversation.BindAgentSession(
                        done.SessionId,
                        timeProvider.GetUtcNow().UtcDateTime);
                    await conversationRepository.SaveChangesAsync(cancellationToken);
                    terminalEventObserved = true;
                    yield return new ConversationStreamEvent.ResponseCompleted(
                        command.ConversationId,
                        done.LeafId,
                        done.Status);
                    yield break;

                case AgentServiceStreamEvent.Error error:
                    if (!sessionReadyObserved)
                    {
                        throw new InvalidOperationException(
                            "Agent Service returned an error before session-ready.");
                    }

                    terminalEventObserved = true;
                    yield return new ConversationStreamEvent.Error(error.Message);
                    yield break;
            }
        }

        if (!terminalEventObserved)
        {
            throw new InvalidOperationException(
                "Agent Service stream ended without a terminal event.");
        }
    }

    private static void EnsureSessionMatches(Guid expectedSessionId, Guid actualSessionId)
    {
        if (expectedSessionId != actualSessionId)
        {
            throw new InvalidOperationException(
                "Agent Service returned a different session for the conversation.");
        }
    }

    private static void EnsureResolvedSessionMatches(Guid? resolvedSessionId, Guid actualSessionId)
    {
        if (resolvedSessionId is not Guid expectedSessionId)
        {
            throw new InvalidOperationException(
                "Agent Service completed the stream without a resolved session.");
        }

        EnsureSessionMatches(expectedSessionId, actualSessionId);
    }
}
