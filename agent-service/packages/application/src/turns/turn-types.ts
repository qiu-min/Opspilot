import type { AgentMessage, AgentThinkingLevel } from '@opspilot/agent-runtime';
import type { Model } from '@opspilot/model-gateway';

import type { AgentSessionEvent } from '../agent-session/agent-session.js';
import type { ExcelResource } from '../tools/excel-resource.js';

/** Input for one Application-level Turn. */
export interface ExecuteTurnInput {
  readonly sessionId?: string;
  readonly message: AgentMessage;
  readonly model?: Model;
  readonly thinkingLevel?: AgentThinkingLevel;
  readonly excelResource?: ExcelResource;
}

/** Optional observer for one ExecuteTurn execution. */
export interface ExecuteTurnOptions {
  readonly onEvent?: TurnExecutionEventListener;
}

/** Events emitted while the Application resolves and executes one Turn. */
export type TurnExecutionEvent =
  | {
      readonly type: 'session_ready';
      readonly sessionId: string;
      readonly created: boolean;
    }
  | {
      readonly type: 'turn_ready';
      readonly turnId: string;
    }
  | AgentSessionEvent;

/** Receives Application lifecycle events and AgentSession events in order. */
export type TurnExecutionEventListener = (
  event: TurnExecutionEvent,
) => void | Promise<void>;

/** Result produced by one Application-level Turn. */
export interface ExecuteTurnResult {
  readonly sessionId: string;
  readonly turnId: string;
  readonly leafId: string | null;
  readonly messages: readonly AgentMessage[];
}
