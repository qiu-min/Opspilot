import type { AttachmentKind } from "../types";

export function getFileKind(name: string): AttachmentKind {
  const extension = name.split(".").pop()?.toLowerCase();
  if (extension === "xlsx" || extension === "xls") return "xlsx";
  if (extension === "pdf") return "pdf";
  if (extension === "csv") return "csv";
  return "file";
}

export function getFileSize(size: number): string {
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
