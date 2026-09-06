import { Bot, Check, Copy, ThumbsDown, ThumbsUp } from "lucide-react";
import { useState } from "react";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { AssistantMarkdown } from "./assistant-markdown";
import { AgentExecutionCard } from "./agent-execution-card";
import type {
  AssistantTextBlock,
  ConversationResponseBlock,
  ConversationResponseItem,
  ConversationResponseStatus,
} from "../types";

type ConversationResponseViewProps = {
  response: ConversationResponseItem;
  agentName: string;
};

export function ConversationResponseView({
  response,
  agentName,
}: ConversationResponseViewProps) {
  const assistantText = response.blocks
    .filter((block): block is AssistantTextBlock => block.type === "assistant_text")
    .map((block) => block.text)
    .join("\n\n");

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
          <Badge tone="blue">AI generated</Badge>
        </div>
        <Badge tone={getResponseStatusTone(response.status)}>{getResponseStatusLabel(response.status)}</Badge>
      </header>

      <div className="space-y-4 px-4 py-4">
        {response.blocks.map((block) => (
          <ResponseBlockView
            key={block.id}
            block={block}
            responseStatus={response.status}
          />
        ))}
      </div>

      {response.status !== "streaming" && assistantText.length > 0 && (
        <ResponseActions assistantText={assistantText} />
      )}
    </section>
  );
}

function ResponseBlockView({
  block,
  responseStatus,
}: {
  block: ConversationResponseBlock;
  responseStatus: ConversationResponseStatus;
}) {
  if (block.type === "assistant_text") {
    return <AssistantTextBlockView block={block} responseStatus={responseStatus} />;
  }

  return <AgentExecutionCard execution={block} />;
}

function AssistantTextBlockView({
  block,
  responseStatus,
}: {
  block: AssistantTextBlock;
  responseStatus: ConversationResponseStatus;
}) {
  return (
    <div className="min-w-0 px-1 text-sm leading-7 text-ink">
      <AssistantMarkdown content={block.text} />
      {responseStatus === "streaming" && !block.completed && (
        <span className="ml-1 inline-block h-4 w-1 animate-pulse rounded-sm bg-accent align-[-2px] motion-reduce:animate-none" aria-label="Assistant is responding" />
      )}
    </div>
  );
}

function ResponseActions({ assistantText }: { assistantText: string }) {
  const [hasCopied, setHasCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(assistantText);
      setHasCopied(true);
      setCopyError(null);
      window.setTimeout(() => setHasCopied(false), 1800);
    } catch {
      setHasCopied(false);
      setCopyError("Copy unavailable");
      window.setTimeout(() => setCopyError(null), 2400);
    }
  }

  return (
    <footer className="flex items-center gap-0.5 border-t border-line/80 px-4 py-2">
      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleCopy} aria-label={hasCopied ? "Copied response" : "Copy response"} title={hasCopied ? "Copied" : "Copy"}>
        {hasCopied ? <Check size={14} className="text-teal" aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      </Button>
      <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Helpful response" title="Helpful"><ThumbsUp size={14} aria-hidden="true" /></Button>
      <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Unhelpful response" title="Not helpful"><ThumbsDown size={14} aria-hidden="true" /></Button>
      {copyError && <span className="ml-2 text-[10px] font-medium text-danger" role="status">{copyError}</span>}
    </footer>
  );
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
