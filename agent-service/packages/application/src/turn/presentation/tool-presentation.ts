import type { JsonObject } from '@opspilot/model-gateway';

/** UI-safe metadata describing one tool action without exposing raw arguments. */
export interface ToolDisplayInfo {
  readonly title: string;
  readonly subject?: string;
  readonly detail?: string;
}

/** Context supplied to a presentation resolver for one model tool call. */
export interface ToolPresentationContext {
  readonly name: string;
  readonly arguments: JsonObject;
}

/** Resolves optional UI-safe metadata for a tool call. */
export type ToolPresentationResolver = (
  context: ToolPresentationContext,
) => ToolDisplayInfo | undefined;

export interface ResolveToolPresentationOptions {
  readonly resolver?: ToolPresentationResolver;
  readonly name: string;
  readonly arguments: JsonObject;
}

/** Resolves UI-safe metadata and falls back to the tool name on unsafe results. */
export function resolveToolPresentation(
  options: ResolveToolPresentationOptions,
): ToolDisplayInfo {
  let resolved: unknown;
  try {
    resolved = options.resolver?.({
      name: options.name,
      arguments: options.arguments,
    });
  } catch {
    resolved = undefined;
  }

  return normalizeToolDisplayInfo(resolved) ?? { title: options.name };
}

function normalizeToolDisplayInfo(value: unknown): ToolDisplayInfo | undefined {
  if (!isRecord(value) || typeof value.title !== 'string' || value.title.trim().length === 0) {
    return undefined;
  }
  if (value.subject !== undefined && typeof value.subject !== 'string') return undefined;
  if (value.detail !== undefined && typeof value.detail !== 'string') return undefined;
  return {
    title: value.title,
    ...(value.subject === undefined ? {} : { subject: value.subject }),
    ...(value.detail === undefined ? {} : { detail: value.detail }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
