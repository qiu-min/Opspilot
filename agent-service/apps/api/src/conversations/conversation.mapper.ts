import type { RunConversationTurnInput, RunConversationTurnResult } from '@opspilot/application';

import type { ConversationTurnRequest } from './conversation.schemas.js';

export interface ConversationTurnResponse {
  readonly sessionId: string;
  readonly leafId: string | null;
  readonly output: string;
}

export function mapConversationTurnRequest(
  request: ConversationTurnRequest,
): RunConversationTurnInput {
  return {
    ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
    message: {
      role: 'user',
      content: [{ type: 'text', text: request.message }],
    },
  };
}

export function mapConversationTurnResult(
  result: RunConversationTurnResult,
): ConversationTurnResponse {
  return {
    sessionId: result.sessionId,
    leafId: result.leafId,
    output: getFinalAssistantText(result),
  };
}

function getFinalAssistantText(result: RunConversationTurnResult): string {
  for (let index = result.messages.length - 1; index >= 0; index -= 1) {
    const message = result.messages[index];
    if (message?.role !== 'assistant') continue;

    return message.content
      .filter((content) => content.type === 'text')
      .map((content) => content.text)
      .join('');
  }

  return '';
}
