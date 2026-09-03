export type AttachmentKind = "xlsx" | "pdf" | "csv" | "file";

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

export type ToolStepStatus = "complete" | "running" | "queued";

export type ToolStep = {
  id: string;
  title: string;
  detail: string;
  duration: string;
  status: ToolStepStatus;
};
