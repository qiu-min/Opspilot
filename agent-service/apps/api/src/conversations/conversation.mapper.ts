import type { RunConversationTurnInput, RunConversationTurnResult } from '@opspilot/application';

import type { ConversationTurnRequest } from './conversation.schemas.js';

export interface ConversationTurnResponse {
  readonly sessionId: string;
  readonly leafId: string | null;
  readonly status: ConversationTurnStatus;
  readonly output: string;
}

export type ConversationTurnStatus = 'completed' | 'error' | 'aborted';

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
  const assistantMessage = getFinalAssistantMessage(result);

  return {
    sessionId: result.sessionId,
    leafId: result.leafId,
    status: getConversationTurnStatus(assistantMessage?.finishReason),
    output: getAssistantText(assistantMessage),
  };
}

type AssistantMessage = Extract<
  RunConversationTurnResult['messages'][number],
  { readonly role: 'assistant' }
>;

function getFinalAssistantMessage(result: RunConversationTurnResult): AssistantMessage | undefined {
  for (let index = result.messages.length - 1; index >= 0; index -= 1) {
    const message = result.messages[index];
    if (message?.role === 'assistant') return message;
  }

  return undefined;
}

function getConversationTurnStatus(finishReason: string | undefined): ConversationTurnStatus {
  if (finishReason === 'error') return 'error';
  if (finishReason === 'aborted') return 'aborted';
  return 'completed';
}

function getAssistantText(message: AssistantMessage | undefined): string {
  if (message === undefined) return '';

  return message.content
    .filter((content) => content.type === 'text')
    .map((content) => content.text)
    .join('');
}
