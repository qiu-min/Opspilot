import type { TurnStreamActivity, TurnStreamPhase, TurnStreamState, TurnStreamToolExecution } from "./turn-stream-state";
import { aggregateTurnUsage } from "./turn-metrics";
import type { AgentExecutionBlock, AssistantTextBlock, TurnResponseBlock, TurnResponseBlockStatus, TurnResponseItem, TurnResponseStatus } from "./types";

export function humanizeToolName(toolName: string): string { const text = toolName.trim().replace(/[_-]+/g, " ").replace(/\s+/g, " "); return text ? text.replace(/\b\w/g, (character) => character.toUpperCase()) : "Tool execution"; }

export function projectTurnStream(state: TurnStreamState, responseId: string): TurnResponseItem | undefined {
  if (state.phase === "idle") return undefined;
  const blocks = state.activity.flatMap<TurnResponseBlock>((activity) => activity.type === "assistant-message" ? projectAssistantBlock(state, activity, responseId) : projectAgentExecutionBlock(state, activity, responseId));
  const metrics = { ...(state.startedAt === undefined ? {} : { startedAt: state.startedAt }), ...(state.completedAt === undefined ? {} : { completedAt: state.completedAt }), usage: aggregateTurnUsage(state.usageEvents), toolCount: state.toolExecutions.length };
  return { type: "response", id: responseId, turnId: state.turnId, status: projectResponseStatus(state), blocks, metrics };
}
function projectAssistantBlock(state: TurnStreamState, activity: Extract<TurnStreamActivity, { type: "assistant-message" }>, responseId: string): AssistantTextBlock[] {
  const message = state.assistantMessages[activity.messageIndex];
  return message === undefined ? [] : [{ type: "assistant_text", id: `${responseId}-assistant-${activity.messageIndex}`, text: message.text, completed: message.completed }];
}
function projectAgentExecutionBlock(state: TurnStreamState, activity: Extract<TurnStreamActivity, { type: "agent-execution" }>, responseId: string): AgentExecutionBlock[] {
  const tools = state.toolExecutions.filter((tool) => tool.batchId === activity.batchId);
  return tools.length === 0 ? [] : [{ type: "agent_execution", id: `${responseId}-execution-${activity.batchId}`, batchId: activity.batchId, steps: tools.map((tool) => ({ id: tool.callId, callId: tool.callId, name: tool.name, status: projectToolStatus(tool, state.phase), ...(tool.display === undefined ? {} : { display: tool.display }), ...(tool.startedAt === undefined ? {} : { startedAt: tool.startedAt }), ...(tool.completedAt === undefined ? {} : { completedAt: tool.completedAt }) })) }];
}
function projectToolStatus(tool: TurnStreamToolExecution, phase: TurnStreamPhase): TurnResponseBlockStatus { if (tool.status === "completed" || tool.status === "failed") return tool.status; return phase === "streaming" ? tool.status : "interrupted"; }
function projectResponseStatus(state: TurnStreamState): TurnResponseStatus { if (state.phase === "streaming") return "streaming"; if (state.phase === "error") return "failed"; if (state.completion?.status === "cancelled" || state.completion?.status === "aborted") return "aborted"; return "completed"; }
