import type { Attachment, ConnectedTool, ContextFile, ConversationItem, ConversationSummary, RecentOutput, RunContextStatus } from "./types";

export const demoAgentName = "OpsPilot";

export const demoConversationId = "conversation-workbook-review";

function getDemoUpdatedAt(daysAgo: number, hour: number, minute: number) {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  date.setHours(hour, minute, 0, 0);
  return date.toISOString();
}

export const demoConversationSummaries: ConversationSummary[] = [
  { id: demoConversationId, title: "Workbook review", updatedAt: getDemoUpdatedAt(0, 10, 41) },
  { id: "conversation-inventory-analysis", title: "Inventory analysis", updatedAt: getDemoUpdatedAt(0, 9, 18) },
  { id: "conversation-sales-workbook", title: "Sales workbook", updatedAt: getDemoUpdatedAt(1, 16, 24) },
  { id: "conversation-operations-report", title: "Operations report", updatedAt: getDemoUpdatedAt(4, 11, 6) },
];

export const demoEnvironmentLabel = "Preview environment";

export const demoComposerAttachments: Attachment[] = [
  { id: "file-1", name: "workbook.xlsx", size: "4.8 MB", kind: "xlsx" },
  { id: "file-2", name: "notes.pdf", size: "842 KB", kind: "pdf" },
];

export const demoTimeline: ConversationItem[] = [
  {
    id: "message-1",
    type: "message",
    message: {
      id: "message-1",
      role: "assistant",
      body: "I found three notable patterns across the workbook. One worksheet contains the clearest change in volume, while a second sheet provides useful context for the outliers. I’m checking the relationships now so you can review the analysis path before we generate a result.",
      createdAt: "10:42",
    },
  },
  {
    id: "message-2",
    type: "message",
    message: {
      id: "message-2",
      role: "user",
      body: "Compare the summary sheet with the supporting notes. Call out anything we should address in the next review.",
      createdAt: "10:43",
      attachments: demoComposerAttachments,
    },
  },
  {
    id: "execution-1",
    type: "agent-execution",
    execution: {
      id: "execution-1",
      title: "Agent execution",
      agentName: demoAgentName,
      toolchainLabel: "Excel analysis toolchain",
      status: "running",
      statusLabel: "Running",
      steps: [
        { id: "read", title: "Read workbook", detail: "Loaded 2 sheets · 4,218 rows", duration: "1.8s", status: "complete" },
        { id: "inspect", title: "Inspect worksheets", detail: "Comparing sheet structure and row relationships...", duration: "Running", status: "running", progress: 68 },
        { id: "result", title: "Generate result", detail: "Queued next", duration: "Queued", status: "queued" },
      ],
      latestOutput: `> read workbook --sheet "Summary"\n✓ 4,218 rows loaded\n> inspect worksheets --match-key "record_id"\n… checking relationships`,
    },
  },
  {
    id: "artifact-1",
    type: "artifact",
    artifact: {
      id: "artifact-1",
      name: "analysis-result.xlsx",
      detail: "Workbook with generated findings",
      size: "24 KB",
      kind: "xlsx",
      generatedAt: "Generated 2m ago",
    },
  },
];

export const demoContextStatus: RunContextStatus = {
  state: "running",
  title: "Analysis in progress",
  detail: `${demoAgentName} is checking the uploaded workbook and supporting notes.`,
  statusLabel: "Running",
  updatedLabel: "Updated just now",
  runLabel: "Preview run",
  progress: 68,
  progressLabel: "68% complete",
};

export const demoContextFiles: ContextFile[] = [
  { id: "context-file-1", name: "workbook.xlsx", detail: "4.8 MB · 2 sheets", kind: "xlsx", statusLabel: "Ready" },
  { id: "context-file-2", name: "notes.pdf", detail: "842 KB · 6 pages", kind: "pdf", statusLabel: "Ready" },
];

export const demoConnectedTools: ConnectedTool[] = [
  { id: "tool-1", title: "Workbook reader", detail: "Read-only", icon: "database" },
  { id: "tool-2", title: "Insight builder", detail: "Enabled", icon: "sparkles" },
  { id: "tool-3", title: "Result writer", detail: "Enabled", icon: "database" },
];

export const demoRecentOutputs: RecentOutput[] = [
  { id: "output-1", name: "analysis-result.xlsx", detail: "Generated 2m ago · 24 KB", kind: "xlsx" },
];
