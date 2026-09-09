import type { ModelToolCall, AssistantMessage } from '@opspilot/model-gateway';
import type { TurnCheckpoint, TurnEvent } from '@opspilot/domain';

export type TurnRecoveryPlan =
  | {
      readonly kind: 'reconcile_terminal';
      readonly terminalEvent: Extract<
        TurnEvent,
        { type: 'turn_completed' | 'turn_failed' | 'turn_cancelled' }
      >;
    }
  | {
      readonly kind: 'complete_from_assistant';
      readonly sessionLeafId: string;
      readonly effectiveCheckpoint: TurnCheckpoint;
    }
  | {
      readonly kind: 'continue_model';
      readonly sessionLeafId: string;
      readonly effectiveCheckpoint: TurnCheckpoint;
    }
  | {
      readonly kind: 'resume_tools';
      readonly sessionLeafId: string;
      readonly assistantEntryId: string;
      readonly assistantMessage: AssistantMessage;
      readonly pendingToolCalls: readonly ModelToolCall[];
      readonly effectiveCheckpoint: TurnCheckpoint;
    }
  | {
      readonly kind: 'blocked';
      readonly reason: string;
      readonly callIds?: readonly string[];
      readonly effectiveCheckpoint?: TurnCheckpoint;
    }
  | {
      readonly kind: 'unrecoverable';
      readonly reason: string;
    };
