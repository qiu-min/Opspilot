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
