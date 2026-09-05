import type { FileKind } from "../../lib/files";

export type AttachmentKind = FileKind;

export type Attachment = {
  id: string;
  name: string;
  size: string;
  kind: AttachmentKind;
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

export type AgentExecutionStep = {
  id: string;
  title: string;
  detail?: string;
  duration?: string;
  status: AgentExecutionStatus;
  progress?: number;
};

export type AgentExecution = {
  id: string;
  title: string;
  agentName: string;
  toolchainLabel: string;
  status: AgentExecutionStatus;
  statusLabel: string;
  steps: AgentExecutionStep[];
  latestOutput?: string;
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
  | {
      type: "agent-execution";
      id: string;
      execution: AgentExecution;
    }
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
