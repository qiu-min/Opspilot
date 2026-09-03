export type ApiProblemDetails = {
  status?: number;
  title?: string;
  detail?: string;
};

export type ApiRequestOptions = {
  method?: RequestInit["method"];
  body?: unknown;
  signal?: AbortSignal;
  accessToken?: string;
  headers?: HeadersInit;
};

export class ApiError extends Error {
  readonly status: number;
  readonly title: string;
  readonly detail: string;

  constructor(status: number, title: string, detail: string) {
    super(detail || title);
    this.name = "ApiError";
    this.status = status;
    this.title = title;
    this.detail = detail;
  }
}

export async function apiRequest<TResponse>(
  path: string,
  options: ApiRequestOptions = {},
): Promise<TResponse> {
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");

  const requestInit: RequestInit = {
    method: options.method,
    headers,
    signal: options.signal,
  };

  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
    requestInit.body = JSON.stringify(options.body);
  }

  if (options.accessToken) {
    headers.set("Authorization", `Bearer ${options.accessToken}`);
  }

  const response = await fetch(path, requestInit);

  if (!response.ok) {
    throw await createApiError(response);
  }

  return parseJsonResponse<TResponse>(response);
}

async function createApiError(response: Response): Promise<ApiError> {
  const bodyText = await response.text();
  const problemDetails = parseProblemDetails(bodyText);
  const fallbackTitle = `HTTP ${response.status}`;
  const fallbackDetail =
    bodyText.trim() ||
    `The request failed with status ${response.status}${response.statusText ? ` (${response.statusText})` : ""}.`;

  return new ApiError(
    response.status,
    problemDetails?.title ?? fallbackTitle,
    problemDetails?.detail ?? fallbackDetail,
  );
}

async function parseJsonResponse<TResponse>(response: Response): Promise<TResponse> {
  const bodyText = await response.text();

  try {
    return JSON.parse(bodyText) as TResponse;
  } catch (error: unknown) {
    throw new ApiError(
      response.status,
      "Invalid JSON response",
      "The server returned an invalid JSON response.",
    );
  }
}

function parseProblemDetails(bodyText: string): ApiProblemDetails | undefined {
  if (!bodyText.trim()) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(bodyText);

    if (!isRecord(parsed)) {
      return undefined;
    }

    return {
      status: typeof parsed.status === "number" ? parsed.status : undefined,
      title: typeof parsed.title === "string" ? parsed.title : undefined,
      detail: typeof parsed.detail === "string" ? parsed.detail : undefined,
    };
  } catch (error: unknown) {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
