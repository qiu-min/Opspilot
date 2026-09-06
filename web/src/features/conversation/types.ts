import type { FileKind } from "../../lib/files";

export type AttachmentKind = FileKind;

export type Attachment = {
  id: string;
  name: string;
  size: string;
  kind: AttachmentKind;
};

/** A browser-only attachment that has not been sent yet. */
export type PendingAttachment = Attachment & {
  file: File;
};

export type ChatMessage = {
  id: string;
  role: "assistant" | "user";
  body: string;
  createdAt: string;
  attachments?: Attachment[];
};

export type ConversationSummary = {
  id: string;
  title: string;
  updatedAt: string;
};

export type AgentExecutionStatus = "queued" | "running" | "complete" | "failed";

export type ConversationResponseStatus = "streaming" | "completed" | "failed" | "aborted";

export type ConversationResponseBlockStatus =
  | "running"
  | "completed"
  | "failed"
  | "interrupted";

export type AssistantTextBlock = {
  type: "assistant_text";
  id: string;
  text: string;
  completed: boolean;
  createdAt: string;
};

export type ToolExecutionBlock = {
  type: "tool_execution";
  id: string;
  callId: string;
  name: string;
  status: ConversationResponseBlockStatus;
  createdAt: string;
};

export type ConversationResponseBlock = AssistantTextBlock | ToolExecutionBlock;

export type ConversationResponseItem = {
  type: "response";
  id: string;
  status: ConversationResponseStatus;
  blocks: ConversationResponseBlock[];
};

export type GeneratedArtifact = {
  id: string;
  name: string;
  detail: string;
  size: string;
  kind: AttachmentKind;
  generatedAt: string;
};

export type ConversationItem =
  | {
      type: "message";
      id: string;
      message: ChatMessage;
    }
  | ConversationResponseItem
  | {
      type: "artifact";
      id: string;
      artifact: GeneratedArtifact;
    };

export type RunContextStatus = {
  state: AgentExecutionStatus;
  title: string;
  detail: string;
  statusLabel: string;
  updatedLabel: string;
  runLabel: string;
  progress?: number;
  progressLabel?: string;
};

export type ContextFile = {
  id: string;
  name: string;
  detail: string;
  kind: AttachmentKind;
  statusLabel: string;
};

export type ConnectedTool = {
  id: string;
  title: string;
  detail: string;
  icon: "database" | "sparkles";
};

export type RecentOutput = {
  id: string;
  name: string;
  detail: string;
  kind: AttachmentKind;
};
