import { Bot, Check, CircleDashed, LoaderCircle, XCircle } from "lucide-react";
import { Badge } from "../../../components/ui/badge";
import { cn } from "../../../lib/utils";
import { getToolPresentation } from "../conversation-stream-projection";
import type {
  ConversationResponseBlock,
  ConversationResponseItem,
  ConversationResponseStatus,
  ToolExecutionBlock,
} from "../types";
import { ChatMessageView } from "./chat-message";

type ConversationResponseViewProps = {
  response: ConversationResponseItem;
  agentName: string;
};

export function ConversationResponseView({
  response,
  agentName,
}: ConversationResponseViewProps) {
  return (
    <section
      className="overflow-hidden rounded-xl border border-line bg-surface shadow-hairline"
      aria-label={`${agentName} response`}
    >
      <header className="flex items-center justify-between gap-3 border-b border-line/80 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand text-white" aria-hidden="true">
            <Bot size={16} strokeWidth={2.1} />
          </div>
          <span className="truncate text-xs font-semibold text-ink">{agentName}</span>
        </div>
        <Badge tone={getResponseStatusTone(response.status)}>{getResponseStatusLabel(response.status)}</Badge>
      </header>

      <div className="space-y-4 px-4 py-4">
        {response.blocks.map((block) => (
          <ResponseBlockView key={block.id} block={block} agentName={agentName} responseStatus={response.status} />
        ))}
      </div>
    </section>
  );
}

function ResponseBlockView({
  block,
  agentName,
  responseStatus,
}: {
  block: ConversationResponseBlock;
  agentName: string;
  responseStatus: ConversationResponseStatus;
}) {
  if (block.type === "assistant_text") {
    return (
      <ChatMessageView
        message={{
          id: block.id,
          role: "assistant",
          body: block.text,
          createdAt: block.createdAt,
        }}
        agentName={agentName}
        isStreaming={responseStatus === "streaming" && !block.completed}
      />
    );
  }

  return <ToolExecutionBlockView block={block} />;
}

function ToolExecutionBlockView({ block }: { block: ToolExecutionBlock }) {
  const presentation = getToolPresentation(block.name);
  const statusTone = getToolStatusTone(block.status);

  return (
    <div className="flex items-center gap-3 rounded-lg border border-line/80 bg-slate-50/70 px-3 py-2.5" aria-label={`${presentation.title} ${getToolStatusLabel(block)}`}>
      <ToolStatusIcon status={block.status} />
      <div className="min-w-0 flex-1">
        <p className={cn("truncate text-xs font-semibold", block.status === "failed" ? "text-danger" : "text-ink")}>
          {presentation.title}
        </p>
      </div>
      <Badge tone={statusTone}>{getToolStatusLabel(block)}</Badge>
    </div>
  );
}

function ToolStatusIcon({ status }: { status: ToolExecutionBlock["status"] }) {
  if (status === "completed") {
    return <Check size={16} className="shrink-0 text-teal" strokeWidth={2.7} aria-hidden="true" />;
  }
  if (status === "running") {
    return <LoaderCircle size={16} className="shrink-0 animate-spin text-accent motion-reduce:animate-none" aria-hidden="true" />;
  }
  if (status === "failed") {
    return <XCircle size={16} className="shrink-0 text-danger" aria-hidden="true" />;
  }
  return <CircleDashed size={16} className="shrink-0 text-mutedInk" aria-hidden="true" />;
}

function getResponseStatusLabel(status: ConversationResponseStatus): string {
  if (status === "streaming") return "Running";
  if (status === "completed") return "Completed";
  if (status === "aborted") return "Stopped";
  return "Failed";
}

function getResponseStatusTone(status: ConversationResponseStatus) {
  if (status === "streaming") return "orange" as const;
  if (status === "completed") return "teal" as const;
  if (status === "failed") return "danger" as const;
  return "neutral" as const;
}

function getToolStatusLabel(block: ToolExecutionBlock): string {
  if (block.status === "running") return "Running";
  if (block.status === "completed") return "Completed";
  if (block.status === "interrupted") return "Interrupted";
  return "Failed";
}

function getToolStatusTone(blockStatus: ToolExecutionBlock["status"]) {
  if (blockStatus === "running") return "orange" as const;
  if (blockStatus === "completed") return "teal" as const;
  if (blockStatus === "failed") return "danger" as const;
  return "neutral" as const;
}
