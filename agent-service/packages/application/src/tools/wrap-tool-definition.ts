import type { AgentTool } from '@opspilot/agent-runtime';

import type { ToolExecutionContext } from './tool-context.js';
import type { ToolDefinition } from './tool-definition.js';

/** Adapts one Application ToolDefinition to the Agent Runtime tool contract. */
export function wrapToolDefinition<TDetails>(
  definition: ToolDefinition<TDetails>,
  context: ToolExecutionContext,
): AgentTool<TDetails> {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    execute(callId, args, signal) {
      return definition.execute(callId, args, signal, context);
    },
  };
}

/** Adapts Application ToolDefinitions in their original order. */
export function wrapToolDefinitions(
  definitions: readonly ToolDefinition[],
  context: ToolExecutionContext,
): readonly AgentTool[] {
  return definitions
    .filter(
      (definition) =>
        definition.requiresExcelResource !== true || context.excelResources.length > 0,
    )
    .map((definition) => wrapToolDefinition(definition, context));
}
