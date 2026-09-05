import { Plus } from "lucide-react";
import { ChatMessageView } from "./chat-message";
import { AgentExecutionCard } from "./agent-execution-card";
import { GeneratedArtifactCard } from "./generated-artifact";
import type { ConversationItem } from "../types";
import { StreamingConversationResponse } from "./streaming-conversation-response";
import type { ConversationStreamState } from "../conversation-stream-state";

type ConversationThreadProps = {
  conversationId: string;
  items: ConversationItem[];
  agentName: string;
  isExecutionExpanded: boolean;
  onToggleExecution: () => void;
  streamState?: ConversationStreamState;
};

export function ConversationThread({ conversationId, items, agentName, isExecutionExpanded, onToggleExecution, streamState }: ConversationThreadProps) {
  if (items.length === 0 && streamState === undefined) {
    return (
      <div className="flex min-h-[360px] flex-col items-center justify-center text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-brand/10 text-brand" aria-hidden="true"><Plus size={22} /></div>
        <h2 className="mt-4 text-lg font-semibold tracking-[-0.02em] text-ink">Start a new analysis</h2>
        <p className="mt-2 max-w-sm text-sm leading-6 text-mutedInk">Upload a workbook or ask {agentName} a question about your operations data.</p>
      </div>
    );
  }

  return (
    <div className="space-y-7" aria-label="Conversation timeline">
      {items.map((item) => {
        if (item.type === "message") return <ChatMessageView key={item.id} message={item.message} agentName={agentName} />;
        if (item.type === "agent-execution") return <AgentExecutionCard key={item.id} execution={item.execution} isExpanded={isExecutionExpanded} onToggle={onToggleExecution} />;
        return <GeneratedArtifactCard key={item.id} artifact={item.artifact} />;
      })}
      {streamState && (
        <StreamingConversationResponse
          conversationId={conversationId}
          streamState={streamState}
          agentName={agentName}
          isExecutionExpanded={isExecutionExpanded}
          onToggleExecution={onToggleExecution}
        />
      )}
    </div>
  );
}
