import type { Message } from '@opspilot/model-gateway';

import type { AgentMessage } from './types.js';

/**
 * 判断消息是否属于 model-gateway 的标准消息。
 * @param message 待判断的 Agent 消息。
 */
function isModelMessage(message: AgentMessage): message is Message {
  if (typeof message !== 'object' || message === null || !('role' in message)) return false;
  return message.role === 'user' || message.role === 'assistant' || message.role === 'tool';
}

/**
 * 将标准 Agent 消息转换为模型消息，并过滤暂不支持的自定义消息。
 * @param messages Agent Runtime 当前维护的消息集合。
 */
export function defaultConvertToLlm(messages: readonly AgentMessage[]): Message[] {
  return messages.filter(isModelMessage);
}
