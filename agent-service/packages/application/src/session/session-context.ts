import type { AgentMessage, AgentThinkingLevel } from '@opspilot/agent-runtime';
import type { Session } from '@opspilot/domain';

import { buildSessionMessageProjection } from './session-projection.js';

/** Application projection used to restore a Session into Agent Runtime. */
export interface SessionContext {
  readonly messages: AgentMessage[];
  readonly thinkingLevel: AgentThinkingLevel;
  readonly model: {
    readonly provider: string;
    readonly modelId: string;
  } | null;
}

/** Projects durable Session state into the runtime-specific context shape. */
export function buildSessionContext(session: Session): SessionContext {
  const branch = session.getBranch();
  const projection = buildSessionMessageProjection(branch);
  let thinkingLevel: AgentThinkingLevel = 'off';
  let model: SessionContext['model'] = null;
  const messages: AgentMessage[] = projection.messages.map((item) => structuredClone(item.message));

  for (const entry of branch) {
    switch (entry.type) {
      case 'message':
        if (entry.message.role === 'assistant') {
          model = {
            provider: entry.message.provider,
            modelId: entry.message.model,
          };
        }
        break;
      case 'thinking_level_change':
        thinkingLevel = entry.thinkingLevel;
        break;
      case 'model_change':
        model = { provider: entry.provider, modelId: entry.modelId };
        break;
      case 'compaction':
        break;
    }
  }

  return { messages, thinkingLevel, model };
}
