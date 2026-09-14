import type {
  ExecuteTurnInput,
  ExecuteTurnOptions,
  ExecuteTurnResult,
} from '@opspilot/application';

import type { EvalCase } from '../core/eval-case.js';
import type { EvalExecutor } from '../core/eval-executor.js';
import type { EvalRunResult } from '../core/eval-run-result.js';

/** Input accepted by the default Agent adapter: a prompt or an existing Runtime message. */
export type AgentEvalInput = string | ExecuteTurnInput['message'];

/** The small public Application surface needed by AgentEvalExecutor. */
export interface ApplicationTurnExecutor {
  execute(input: ExecuteTurnInput, options?: ExecuteTurnOptions): Promise<ExecuteTurnResult>;
}

export interface AgentEvalExecutorOptions {
  readonly executeTurn: ApplicationTurnExecutor;
  readonly model?: ExecuteTurnInput['model'];
  readonly thinkingLevel?: ExecuteTurnInput['thinkingLevel'];
  readonly onEvent?: ExecuteTurnOptions['onEvent'];
  readonly inputToMessage?: (input: AgentEvalInput) => ExecuteTurnInput['message'];
}

/** Adapts the real Application ExecuteTurn entry point to the generic EvalExecutor contract. */
export class AgentEvalExecutor implements EvalExecutor<AgentEvalInput, ExecuteTurnResult> {
  private readonly executeTurn: ApplicationTurnExecutor;
  private readonly model?: ExecuteTurnInput['model'];
  private readonly thinkingLevel?: ExecuteTurnInput['thinkingLevel'];
  private readonly onEvent?: ExecuteTurnOptions['onEvent'];
  private readonly inputToMessage: (input: AgentEvalInput) => ExecuteTurnInput['message'];

  /** Creates an adapter without owning or recreating Application Session/Turn dependencies. */
  public constructor(options: AgentEvalExecutorOptions) {
    this.executeTurn = options.executeTurn;
    this.model = options.model;
    this.thinkingLevel = options.thinkingLevel;
    this.onEvent = options.onEvent;
    this.inputToMessage = options.inputToMessage ?? toAgentUserMessage;
  }

  /** Executes one case through Application and translates its result into EvalRunResult. */
  public async execute(
    evalCase: EvalCase<AgentEvalInput, unknown>,
  ): Promise<EvalRunResult<ExecuteTurnResult>> {
    const startedAt = Date.now();
    try {
      const result = await this.executeTurn.execute(
        {
          message: this.inputToMessage(evalCase.input),
          model: this.model,
          thinkingLevel: this.thinkingLevel,
        },
        this.onEvent === undefined ? undefined : { onEvent: this.onEvent },
      );
      const failedAssistant = findFailedAssistant(result);

      return {
        caseId: evalCase.id,
        status: failedAssistant === undefined ? 'completed' : 'failed',
        actual: result,
        durationMs: elapsedMilliseconds(startedAt),
        metadata: {
          sessionId: result.sessionId,
          turnId: result.turnId,
          leafId: result.leafId,
        },
        ...(failedAssistant === undefined
          ? {}
          : {
              error: {
                message:
                  failedAssistant.errorMessage ??
                  `Agent Turn ended with ${failedAssistant.finishReason}.`,
              },
            }),
      };
    } catch (error: unknown) {
      return {
        caseId: evalCase.id,
        status: 'error',
        durationMs: elapsedMilliseconds(startedAt),
        error: { message: errorMessage(error) },
      };
    }
  }
}

/** Converts a plain smoke prompt into the standard Application user message. */
function toAgentUserMessage(input: AgentEvalInput): ExecuteTurnInput['message'] {
  if (typeof input !== 'string') return input;
  return { role: 'user', content: [{ type: 'text', text: input }] };
}

/** Finds a model/runtime failure without depending on the position of the final message. */
function findFailedAssistant(
  result: ExecuteTurnResult,
): Extract<ExecuteTurnResult['messages'][number], { role: 'assistant' }> | undefined {
  return [...result.messages].reverse().find((message) => {
    return (
      message.role === 'assistant' &&
      (message.finishReason === 'error' || message.finishReason === 'aborted')
    );
  }) as Extract<ExecuteTurnResult['messages'][number], { role: 'assistant' }> | undefined;
}

/** Converts an unknown thrown value into a stable error message. */
function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return String(error);
}

/** Keeps duration non-negative even when the system clock changes during execution. */
function elapsedMilliseconds(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}
