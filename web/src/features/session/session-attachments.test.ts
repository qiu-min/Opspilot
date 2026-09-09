import { describe, expect, it } from "vitest";
import { SessionAttachmentValidationError, uploadPendingAttachment } from "./session-attachments";

describe("Session attachments", () => {
  it("uploads one xlsx attachment", async () => {
    const file = new File(["data"], "report.xlsx");
    const result = await uploadPendingAttachment([{ id: "1", name: file.name, size: "4 B", kind: "xlsx", file }], "token", new AbortController().signal, async () => ({ id: "file-1", fileName: file.name, sizeBytes: 4, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", createdAtUtc: "2026-09-09T00:00:00Z" }));
    expect(result.fileId).toBe("file-1");
  });

  it("rejects non-xlsx files", async () => {
    const file = new File(["data"], "report.csv");
    await expect(uploadPendingAttachment([{ id: "1", name: file.name, size: "4 B", kind: "csv", file }], "token", new AbortController().signal, async () => ({ id: "file-1", fileName: file.name, sizeBytes: 4, contentType: "text/csv", createdAtUtc: "2026-09-09T00:00:00Z" }))).rejects.toBeInstanceOf(SessionAttachmentValidationError);
  });
});
