import { apiRequest } from "../client";
import type { UploadFileResponse } from "./files-contracts";

export function uploadFile(
  file: File,
  accessToken: string,
  signal?: AbortSignal,
): Promise<UploadFileResponse> {
  const formData = new FormData();
  formData.append("file", file);

  return apiRequest<UploadFileResponse>("/api/files", {
    method: "POST",
    body: formData,
    accessToken,
    signal,
  });
}
