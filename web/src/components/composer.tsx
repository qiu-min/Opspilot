import { FilePlus2, Mic, Paperclip, Send, X } from "lucide-react";
import { useRef } from "react";
import { Button } from "./ui/button";
import type { Attachment } from "../types";

export type ComposerSubmitPayload = {
  body: string;
  attachments: Attachment[];
};

type ComposerProps = {
  draft: string;
  attachments: Attachment[];
  isProcessing: boolean;
  agentName: string;
  onDraftChange: (value: string) => void;
  onSubmit: (payload: ComposerSubmitPayload) => void;
  onAttach: (files: FileList) => void;
  onRemoveAttachment: (id: string) => void;
};

export function Composer({ draft, attachments, isProcessing, agentName, onDraftChange, onSubmit, onAttach, onRemoveAttachment }: ComposerProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = draft.trim();
    if (!body || isProcessing) return;
    onSubmit({ body, attachments: [...attachments] });
  }

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    if (event.target.files && event.target.files.length > 0) {
      onAttach(event.target.files);
      event.target.value = "";
    }
  }

  return (
    <div className="shrink-0 border-t border-line bg-surface px-4 pb-4 pt-3 sm:px-6">
      {attachments.length > 0 && (
        <div className="mb-2.5 flex flex-wrap gap-2" aria-label="Attached files">
          {attachments.map((attachment) => (
            <div key={attachment.id} className="flex max-w-full items-center gap-2 rounded-lg border border-line bg-[#f8fafc] px-2.5 py-1.5">
              <FilePlus2 size={14} className={attachment.kind === "pdf" ? "text-[#d04a3c]" : "text-teal"} aria-hidden="true" />
              <span className="max-w-[180px] truncate text-[11px] font-medium text-ink">{attachment.name}</span>
              <span className="text-[10px] text-mutedInk">{attachment.size}</span>
              <button type="button" className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-mutedInk transition hover:bg-slate-200 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60" onClick={() => onRemoveAttachment(attachment.id)} aria-label={`Remove ${attachment.name}`} title="Remove attachment"><X size={13} aria-hidden="true" /></button>
            </div>
          ))}
        </div>
      )}
      <form onSubmit={handleSubmit} className="rounded-xl border border-line bg-[#fbfcfd] p-2 shadow-hairline transition focus-within:border-brand/50 focus-within:ring-2 focus-within:ring-brand/10">
        <label htmlFor="message-composer" className="sr-only">Message {agentName}</label>
        <textarea
          id="message-composer"
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          placeholder={`Ask ${agentName} to analyze your workspace...`}
          rows={2}
          className="min-h-[52px] w-full resize-none border-0 bg-transparent px-2 py-1.5 text-[14px] leading-6 text-ink outline-none placeholder:text-slate-400"
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <div className="flex items-center justify-between gap-2 px-1 pt-1">
          <div className="flex items-center gap-0.5">
            <input ref={inputRef} type="file" className="sr-only" multiple accept=".xlsx,.xls,.csv,.pdf" onChange={handleFileChange} />
            <Button variant="ghost" size="icon" className="h-9 w-9" onClick={() => inputRef.current?.click()} aria-label="Attach files" title="Attach files"><Paperclip size={16} aria-hidden="true" /></Button>
            <Button variant="ghost" size="icon" className="h-9 w-9" aria-label="Add analysis instruction" title="Add instruction"><FilePlus2 size={16} aria-hidden="true" /></Button>
            <span className="ml-2 hidden text-[10px] text-mutedInk sm:inline">Shift + Enter for new line</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Button variant="ghost" size="icon" className="h-9 w-9" aria-label="Use voice input" title="Voice input"><Mic size={16} aria-hidden="true" /></Button>
            <Button type="submit" variant="primary" size="icon" className="h-9 w-9 rounded-lg" disabled={isProcessing || draft.trim().length === 0} aria-label={isProcessing ? `${agentName} is working` : "Send message"} title={isProcessing ? `${agentName} is working` : "Send message"}>
              <Send size={15} className={isProcessing ? "opacity-60" : ""} aria-hidden="true" />
            </Button>
          </div>
        </div>
      </form>
      <p className="mt-2 text-center text-[10px] text-mutedInk">{agentName} can make mistakes. Review generated analysis before sharing.</p>
    </div>
  );
}
