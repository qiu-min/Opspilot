import { Bot, Check, Copy, FileSpreadsheet, ThumbsDown, ThumbsUp, UserRound } from "lucide-react";
import { useState } from "react";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { AssistantMarkdown } from "./assistant-markdown";
import type { ChatMessage } from "../types";

type ChatMessageProps = {
  message: ChatMessage;
  agentName: string;
};

export function ChatMessageView({ message, agentName }: ChatMessageProps) {
  const isAssistant = message.role === "assistant";
  const [hasCopied, setHasCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(message.body);
      setHasCopied(true);
      setCopyError(null);
      window.setTimeout(() => setHasCopied(false), 1800);
    } catch (error: unknown) {
      setHasCopied(false);
      setCopyError(error instanceof Error ? "Copy unavailable" : "Copy failed");
      window.setTimeout(() => setCopyError(null), 2400);
    }
  }

  return (
    <article className={isAssistant ? "flex gap-3" : "flex flex-row-reverse gap-3"} aria-label={`${isAssistant ? agentName : "You"} message`}>
      <div className={isAssistant ? "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand text-white" : "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-ink text-white"} aria-hidden="true">
        {isAssistant ? <Bot size={16} strokeWidth={2.1} /> : <UserRound size={16} strokeWidth={2} />}
      </div>
      <div className={isAssistant ? "min-w-0 max-w-[760px] flex-1" : "min-w-0 max-w-[620px]"}>
        <div className={isAssistant ? "mb-1.5 flex items-center gap-2" : "mb-1.5 flex flex-row-reverse items-center gap-2"}>
          <span className="text-xs font-semibold text-ink">{isAssistant ? agentName : "You"}</span>
          {isAssistant && <Badge tone="blue">AI generated</Badge>}
          <span className="text-[10px] text-mutedInk">{message.createdAt}</span>
        </div>
        <div className={isAssistant ? "rounded-r-xl rounded-bl-xl border border-line bg-surface px-4 py-3.5 shadow-hairline" : "rounded-l-xl rounded-br-xl bg-ink px-4 py-3.5 text-white"}>
          {isAssistant ? (
            <AssistantMarkdown content={message.body} />
          ) : (
            <p className="whitespace-pre-wrap text-[14px] leading-7 text-white/95">{message.body}</p>
          )}
          {message.attachments && message.attachments.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {message.attachments.map((attachment) => (
                <div key={attachment.id} className={isAssistant ? "flex items-center gap-2 rounded-lg border border-line bg-slate-50 px-2.5 py-2" : "flex items-center gap-2 rounded-lg border border-white/[0.15] bg-white/[0.1] px-2.5 py-2"}>
                  <FileSpreadsheet size={14} className={isAssistant ? "text-teal" : "text-[#a9c4ec]"} aria-hidden="true" />
                  <span className="max-w-[180px] truncate text-[11px] font-medium">{attachment.name}</span>
                  <span className={isAssistant ? "text-[10px] text-mutedInk" : "text-[10px] text-white/55"}>{attachment.size}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        {isAssistant && (
          <div className="mt-1.5 flex items-center gap-0.5">
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleCopy} aria-label={hasCopied ? "Copied message" : "Copy message"} title={hasCopied ? "Copied" : "Copy"}>
              {hasCopied ? <Check size={14} className="text-teal" aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Helpful response" title="Helpful"><ThumbsUp size={14} aria-hidden="true" /></Button>
            <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Unhelpful response" title="Not helpful"><ThumbsDown size={14} aria-hidden="true" /></Button>
            {copyError && <span className="ml-2 text-[10px] font-medium text-danger" role="status">{copyError}</span>}
          </div>
        )}
      </div>
    </article>
  );
}
