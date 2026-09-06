import { Plus } from "lucide-react";
import { ChatMessageView } from "./chat-message";
import { ConversationResponseView } from "./conversation-response-view";
import { GeneratedArtifactCard } from "./generated-artifact";
import type { ConversationItem } from "../types";

type ConversationThreadProps = {
  items: ConversationItem[];
  agentName: string;
};

export function ConversationThread({ items, agentName }: ConversationThreadProps) {
  if (items.length === 0) {
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
        if (item.type === "response") return <ConversationResponseView key={item.id} response={item} agentName={agentName} />;
        return <GeneratedArtifactCard key={item.id} artifact={item.artifact} />;
      })}
    </div>
  );
}
