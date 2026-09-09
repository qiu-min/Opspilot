import type { FileKind } from "../../lib/files";

export type AttachmentKind = FileKind;
export type Attachment = { id: string; name: string; size: string; kind: AttachmentKind };
export type PendingAttachment = Attachment & { file: File };
export type ChatMessage = { id: string; role: "assistant" | "user"; body: string; createdAt: string; attachments?: Attachment[] };
export type SessionSummary = { id: string; title: string; updatedAt: string };
export type AgentExecutionStatus = "queued" | "running" | "complete" | "failed";
export type TurnResponseStatus = "streaming" | "completed" | "failed" | "aborted";
export type TurnResponseBlockStatus = "queued" | "running" | "completed" | "failed" | "interrupted";
export type AssistantTextBlock = { type: "assistant_text"; id: string; text: string; completed: boolean };
export type AgentExecutionStep = { id: string; callId: string; name: string; status: TurnResponseBlockStatus };
export type AgentExecutionBlock = { type: "agent_execution"; id: string; batchId: string; steps: AgentExecutionStep[] };
export type TurnResponseBlock = AssistantTextBlock | AgentExecutionBlock;
export type TurnResponseItem = { type: "response"; id: string; status: TurnResponseStatus; blocks: TurnResponseBlock[] };
export type GeneratedArtifact = { id: string; name: string; detail: string; size: string; kind: AttachmentKind; generatedAt: string };
export type SessionItem =
  | { type: "message"; id: string; message: ChatMessage }
  | TurnResponseItem
  | { type: "artifact"; id: string; artifact: GeneratedArtifact };
export type RunContextStatus = { state: AgentExecutionStatus; title: string; detail: string; statusLabel: string; updatedLabel: string; runLabel: string; progress?: number; progressLabel?: string };
export type ContextFile = { id: string; name: string; detail: string; kind: AttachmentKind; statusLabel: string };
export type ConnectedTool = { id: string; title: string; detail: string; icon: "database" | "sparkles" };
export type RecentOutput = { id: string; name: string; detail: string; kind: AttachmentKind };
