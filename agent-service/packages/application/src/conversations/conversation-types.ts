import type { AgentMessage, AgentThinkingLevel } from '@opspilot/agent-runtime';
import type { Model } from '@opspilot/model-gateway';

import type { AgentSessionEventListener } from '../agent-session/agent-session.js';
import type { ExcelResource } from '../tools/excel-resource.js';

/** Input for one application-level conversation turn. */
export interface RunConversationTurnInput {
  readonly sessionId?: string;
  readonly message: AgentMessage;
  readonly model?: Model;
  readonly thinkingLevel?: AgentThinkingLevel;
  readonly excelResource?: ExcelResource;
}

/** Optional event listener for one RunConversationTurn execution. */
export interface RunConversationTurnExecutionOptions {
  readonly onEvent?: AgentSessionEventListener;
}

/** Messages and session identifiers produced by one conversation turn. */
export interface RunConversationTurnResult {
  readonly sessionId: string;
  readonly leafId: string | null;
  readonly messages: readonly AgentMessage[];
}
