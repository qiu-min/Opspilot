import { describe, expect, it, vi } from "vitest";
import {
  ConversationAttachmentValidationError,
  createPendingAttachment,
  isXlsxFile,
  replacePendingAttachment,
  uploadPendingAttachment,
} from "./conversation-attachments";

function createFile(name: string, lastModified = 1): File {
  return new File(["workbook"], name, {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    lastModified,
  });
}

describe("conversation attachments", () => {
  it("accepts only .xlsx files and replaces the previous pending file", () => {
    const firstFile = createFile("first.xlsx", 1);
    const secondFile = createFile("second.xlsx", 2);
    const firstAttachment = createPendingAttachment(firstFile);

    expect(isXlsxFile(firstFile)).toBe(true);
    expect(isXlsxFile(createFile("legacy.xls"))).toBe(false);
    expect(replacePendingAttachment(secondFile)).toHaveLength(1);
    expect(replacePendingAttachment(secondFile)[0].name).toBe("second.xlsx");
    expect(firstAttachment.file).toBe(firstFile);
  });

  it("returns null fileId without uploading a text-only turn", async () => {
    const upload = vi.fn();

    await expect(
      uploadPendingAttachment([], "token", new AbortController().signal, upload),
    ).resolves.toEqual({ fileId: null });
    expect(upload).not.toHaveBeenCalled();
  });

  it("uploads one Excel file before the caller starts the conversation stream", async () => {
    const file = createFile("report.xlsx");
    const pendingAttachment = createPendingAttachment(file);
    const callOrder: string[] = [];
    const upload = vi.fn(async (uploadedFile: File) => {
      callOrder.push(`upload:${uploadedFile.name}`);
      return {
        id: "file-123",
        fileName: uploadedFile.name,
        contentType: uploadedFile.type,
        sizeBytes: uploadedFile.size,
        createdAtUtc: "2026-09-06T00:00:00Z",
      };
    });

    const prepared = await uploadPendingAttachment(
      [pendingAttachment],
      "token",
      new AbortController().signal,
      upload,
    );
    callOrder.push(`stream:${prepared.fileId}`);

    expect(callOrder).toEqual(["upload:report.xlsx", "stream:file-123"]);
    expect(prepared.fileId).toBe("file-123");
    expect(prepared.attachment).toEqual({
      id: pendingAttachment.id,
      name: "report.xlsx",
      size: pendingAttachment.size,
      kind: "xlsx",
    });
    expect(prepared.attachment).not.toHaveProperty("file");
  });

  it("keeps upload failures before any stream call", async () => {
    const upload = vi.fn(async () => {
      throw new Error("upload failed");
    });
    const stream = vi.fn();

    await expect(
      uploadPendingAttachment(
        [createPendingAttachment(createFile("report.xlsx"))],
        "token",
        new AbortController().signal,
        upload,
      ),
    ).rejects.toThrow("upload failed");
    expect(stream).not.toHaveBeenCalled();
  });

  it("rejects invalid or multiple pending files", async () => {
    const upload = vi.fn();
    const signal = new AbortController().signal;

    await expect(
      uploadPendingAttachment(
        [createPendingAttachment(createFile("report.xls"))],
        "token",
        signal,
        upload,
      ),
    ).rejects.toBeInstanceOf(ConversationAttachmentValidationError);
    await expect(
      uploadPendingAttachment(
        [
          createPendingAttachment(createFile("first.xlsx")),
          createPendingAttachment(createFile("second.xlsx")),
        ],
        "token",
        signal,
        upload,
      ),
    ).rejects.toBeInstanceOf(ConversationAttachmentValidationError);
    expect(upload).not.toHaveBeenCalled();
  });
});
