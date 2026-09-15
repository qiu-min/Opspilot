/** Builds a stable, unambiguous identity for one ToolCall within one durable Turn. */
export function createToolMutationId(turnId: string, callId: string): string {
  return `turn:${turnId.length}:${turnId}:call:${callId.length}:${callId}`;
}
