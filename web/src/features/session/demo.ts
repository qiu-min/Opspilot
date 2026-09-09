import type { ConnectedTool, ContextFile, RecentOutput, RunContextStatus } from "./types";

export const demoAgentName = "OpsPilot";

export const demoEnvironmentLabel = "Preview environment";

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
