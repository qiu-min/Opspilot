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

export function replacePendingAttachment(file: File): PendingAttachment[] {
  return [createPendingAttachment(file)];
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

export type UploadedConversationAttachment = {
  fileId: string | null;
  attachment?: Attachment;
};

export class ConversationAttachmentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConversationAttachmentValidationError";
  }
}

export async function uploadPendingAttachment(
  pendingAttachments: readonly PendingAttachment[],
  accessToken: string,
  signal: AbortSignal,
  upload: UploadPendingAttachment = uploadFile,
): Promise<UploadedConversationAttachment> {
  if (pendingAttachments.length === 0) {
    return { fileId: null };
  }

  if (pendingAttachments.length > MAX_PENDING_ATTACHMENTS) {
    throw new ConversationAttachmentValidationError("Only one Excel file can be sent per message.");
  }

  const [pendingAttachment] = pendingAttachments;
  if (!isXlsxFile(pendingAttachment.file)) {
    throw new ConversationAttachmentValidationError("Only .xlsx files can be sent.");
  }

  const uploaded = await upload(pendingAttachment.file, accessToken, signal);
  return {
    fileId: uploaded.id,
    attachment: toMessageAttachment(pendingAttachment),
  };
}
