export type FileKind = "xlsx" | "pdf" | "csv" | "file";

export function getFileKind(name: string): FileKind {
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
