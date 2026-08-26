export type ToolErrorKind = 'recoverable' | 'internal' | 'aborted';

export interface ToolErrorDetails<TData = unknown> {
  readonly kind: ToolErrorKind;
  readonly code: string;
  readonly data?: TData;
}

/** 表示模型可能通过修改参数或请求方式恢复的 Tool 错误。 */
export class AgentToolExecutionError<TData = unknown> extends Error {
  readonly code: string;
  readonly data?: TData;
  readonly cause?: unknown;

  constructor(message: string, code: string, data?: TData, cause?: unknown) {
    super(message, { cause });
    this.name = 'AgentToolExecutionError';
    this.code = code;
    this.data = data;
    this.cause = cause;
  }
}
