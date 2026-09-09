import type {
  ExecuteTurnInput,
  ExecuteTurnResult,
  ExcelResource,
} from '@opspilot/application';

import type { ExecuteTurnRequest } from './turn.schemas.js';

export interface ExecuteTurnResponse {
  readonly sessionId: string;
  readonly turnId: string;
  readonly leafId: string | null;
  readonly status: ExecuteTurnStatus;
  readonly output: string;
}

export type ExecuteTurnStatus = 'completed' | 'error' | 'aborted';

export function mapExecuteTurnRequest(
  request: ExecuteTurnRequest,
  excelResource?: ExcelResource,
  sessionId?: string,
): ExecuteTurnInput {
  return {
    ...(sessionId === undefined && request.sessionId === undefined
      ? {}
      : { sessionId: sessionId ?? request.sessionId }),
    message: {
      role: 'user',
      content: [{ type: 'text', text: request.message }],
    },
    ...(excelResource === undefined ? {} : { excelResource }),
  };
}

export function mapExecuteTurnResult(result: ExecuteTurnResult): ExecuteTurnResponse {
  const assistantMessage = getFinalAssistantMessage(result);
  return {
    sessionId: result.sessionId,
    turnId: result.turnId,
    leafId: result.leafId,
    status: getExecuteTurnStatus(assistantMessage?.finishReason),
    output: getAssistantText(assistantMessage),
  };
}

type AssistantMessage = Extract<
  ExecuteTurnResult['messages'][number],
  { readonly role: 'assistant' }
>;

function getFinalAssistantMessage(result: ExecuteTurnResult): AssistantMessage | undefined {
  for (let index = result.messages.length - 1; index >= 0; index -= 1) {
    const message = result.messages[index];
    if (message?.role === 'assistant') return message;
  }
  return undefined;
}

function getExecuteTurnStatus(finishReason: string | undefined): ExecuteTurnStatus {
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
