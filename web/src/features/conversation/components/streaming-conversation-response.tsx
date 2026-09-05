import { LoaderCircle } from "lucide-react";
import { AgentExecutionCard } from "./agent-execution-card";
import { ChatMessageView } from "./chat-message";
import type {
  ConversationStreamPhase,
  ConversationStreamState,
  ConversationStreamToolExecution,
} from "../conversation-stream-state";
import type { AgentExecutionStatus, ChatMessage } from "../types";

type StreamingConversationResponseProps = {
  conversationId: string;
  streamState: ConversationStreamState;
  agentName: string;
  isExecutionExpanded: boolean;
  onToggleExecution: () => void;
};

export function StreamingConversationResponse({
  conversationId,
  streamState,
  agentName,
  isExecutionExpanded,
  onToggleExecution,
}: StreamingConversationResponseProps) {
  return (
    <div className="space-y-7" aria-label="Streaming assistant response">
      {streamState.activity.map((activity) => {
        if (activity.type === "assistant-message") {
          const message = streamState.assistantMessages[activity.messageIndex];
          if (!message) return null;

          const chatMessage: ChatMessage = {
            id: `stream-${conversationId}-assistant-${activity.messageIndex}`,
            role: "assistant",
            body: message.text,
            createdAt: "Now",
          };

          return (
            <ChatMessageView
              key={chatMessage.id}
              message={chatMessage}
              agentName={agentName}
              isStreaming={streamState.phase === "streaming" && !message.completed}
            />
          );
        }

        const tool = streamState.toolExecutions.find(
          (execution) => execution.callId === activity.callId,
        );
        if (!tool) return null;

        return (
          <AgentExecutionCard
            key={`stream-${conversationId}-tool-${tool.callId}`}
            execution={toStreamingToolExecution(tool, conversationId, agentName, streamState.phase)}
            isExpanded={isExecutionExpanded}
            onToggle={onToggleExecution}
          />
        );
      })}

      {streamState.isThinking && (
        <div className="ml-11 flex items-center gap-2 text-xs text-mutedInk" aria-label="Thinking">
          <LoaderCircle
            size={15}
            className="animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
          <span>Thinking</span>
        </div>
      )}
    </div>
  );
}

function toStreamingToolExecution(
  tool: ConversationStreamToolExecution,
  conversationId: string,
  agentName: string,
  streamPhase: ConversationStreamPhase,
) {
  const isInterrupted = tool.status === "running" && streamPhase !== "streaming";
  let status: AgentExecutionStatus;
  if (isInterrupted) {
    status = "failed";
  } else if (tool.status === "running") {
    status = "running";
  } else {
    status = tool.isError ? "failed" : "complete";
  }

  const statusLabel = isInterrupted
    ? "Interrupted"
    : status === "running"
      ? "Running"
      : status === "failed"
        ? "Failed"
        : "Complete";

  return {
    id: `stream-${conversationId}-tool-${tool.callId}`,
    title: "Tool execution",
    agentName,
    toolchainLabel: tool.name,
    status,
    statusLabel,
    steps: [
      {
        id: `stream-${conversationId}-tool-step-${tool.callId}`,
        title: tool.name,
        status,
      },
    ],
  };
}
