import { uploadFile } from "../../api/files/files-api";
import type { UploadFileResponse } from "../../api/files/files-contracts";
import type { Attachment, PendingAttachment } from "./types";
import { getFileKind, getFileSize } from "../../lib/files";

export const MAX_PENDING_ATTACHMENTS = 1;

export function isXlsxFile(file: File): boolean {
  return file.name.toLowerCase().endsWith(".xlsx");
}

export function createPendingAttachment(file: File): PendingAttachment {
  return {
    id: `${file.name}-${file.lastModified}-${file.size}`,
    name: file.name,
    size: getFileSize(file.size),
    kind: getFileKind(file.name),
    file,
  };
}

export function replacePendingAttachment(file: File | undefined): PendingAttachment[] {
  return file === undefined ? [] : [createPendingAttachment(file)];
}

export function toMessageAttachment(attachment: PendingAttachment): Attachment {
  return {
    id: attachment.id,
    name: attachment.name,
    size: attachment.size,
    kind: attachment.kind,
  };
}

export type UploadPendingAttachment = (
  file: File,
  accessToken: string,
  signal: AbortSignal,
) => Promise<UploadFileResponse>;

export type UploadedSessionAttachment = {
  fileId: string | null;
  attachment?: Attachment;
};

export class SessionAttachmentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionAttachmentValidationError";
  }
}

export async function uploadPendingAttachment(
  pendingAttachments: readonly PendingAttachment[],
  accessToken: string,
  signal: AbortSignal,
  upload: UploadPendingAttachment = uploadFile,
): Promise<UploadedSessionAttachment> {
  if (pendingAttachments.length === 0) {
    return { fileId: null };
  }

  if (pendingAttachments.length > MAX_PENDING_ATTACHMENTS) {
    throw new SessionAttachmentValidationError("Only one Excel file can be sent per message.");
  }

  const [pendingAttachment] = pendingAttachments;
  if (!isXlsxFile(pendingAttachment.file)) {
    throw new SessionAttachmentValidationError("Only .xlsx files can be sent.");
  }

  const uploaded = await upload(pendingAttachment.file, accessToken, signal);
  return {
    fileId: uploaded.id,
    attachment: toMessageAttachment(pendingAttachment),
  };
}
