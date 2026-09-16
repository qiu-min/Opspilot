import type {
  ExecuteTurnInput,
  ExecuteTurnOptions,
  ExecuteTurnResult,
} from '@opspilot/application';

import type { EvalCase } from '../core/eval-case.js';
import type { EvalExecutor } from '../core/eval-executor.js';
import type { EvalRunResult } from '../core/eval-run-result.js';

/** Input accepted by the default Agent adapter: a prompt or an existing Runtime message. */
export type AgentEvalMessageInput = string | ExecuteTurnInput['message'];

/** Optional execution metadata for an Eval input, including an attached Excel resource. */
export interface AgentEvalInputWithResource {
  readonly message: AgentEvalMessageInput;
  readonly excelResource?: ExecuteTurnInput['excelResource'];
}

/** Input accepted by the default Agent adapter, with optional per-case resources. */
export type AgentEvalInput = AgentEvalMessageInput | AgentEvalInputWithResource;

/** The small public Application surface needed by AgentEvalExecutor. */
export interface ApplicationTurnExecutor {
  execute(input: ExecuteTurnInput, options?: ExecuteTurnOptions): Promise<ExecuteTurnResult>;
}

export interface AgentEvalExecutorOptions {
  readonly executeTurn: ApplicationTurnExecutor;
  readonly model?: ExecuteTurnInput['model'];
  readonly thinkingLevel?: ExecuteTurnInput['thinkingLevel'];
  readonly onEvent?: ExecuteTurnOptions['onEvent'];
  readonly inputToMessage?: (input: AgentEvalMessageInput) => ExecuteTurnInput['message'];
}

/** Adapts the real Application ExecuteTurn entry point to the generic EvalExecutor contract. */
export class AgentEvalExecutor implements EvalExecutor<AgentEvalInput, ExecuteTurnResult> {
  private readonly executeTurn: ApplicationTurnExecutor;
  private readonly model?: ExecuteTurnInput['model'];
  private readonly thinkingLevel?: ExecuteTurnInput['thinkingLevel'];
  private readonly onEvent?: ExecuteTurnOptions['onEvent'];
  private readonly inputToMessage: (input: AgentEvalMessageInput) => ExecuteTurnInput['message'];

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
        createExecuteTurnInput(evalCase.input, this.inputToMessage, this.model, this.thinkingLevel),
        this.onEvent === undefined ? undefined : { onEvent: this.onEvent },
      );
      const failedAssistant = findFailedAssistant(result);
      const excelResourceId = readExcelResourceId(evalCase.input);

      return {
        caseId: evalCase.id,
        status: failedAssistant === undefined ? 'completed' : 'failed',
        actual: result,
        durationMs: elapsedMilliseconds(startedAt),
        metadata: {
          sessionId: result.sessionId,
          turnId: result.turnId,
          leafId: result.leafId,
          ...(excelResourceId === undefined
            ? {}
            : { excelResourceId }),
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

/** Reads the attached Excel resource identity without exposing its filesystem path. */
function readExcelResourceId(input: AgentEvalInput): string | undefined {
  if (!isAgentEvalInputWithResource(input) || input.excelResource === undefined) return undefined;
  return input.excelResource.id;
}

/** Converts a plain smoke prompt into the standard Application user message. */
function toAgentUserMessage(input: AgentEvalMessageInput): ExecuteTurnInput['message'] {
  if (typeof input !== 'string') return input;
  return { role: 'user', content: [{ type: 'text', text: input }] };
}

/** Converts an Eval input into the Application input without owning resource behavior. */
function createExecuteTurnInput(
  input: AgentEvalInput,
  inputToMessage: (input: AgentEvalMessageInput) => ExecuteTurnInput['message'],
  model: ExecuteTurnInput['model'] | undefined,
  thinkingLevel: ExecuteTurnInput['thinkingLevel'] | undefined,
): ExecuteTurnInput {
  if (isAgentEvalInputWithResource(input)) {
    return {
      message: inputToMessage(input.message),
      model,
      thinkingLevel,
      ...(input.excelResource === undefined ? {} : { excelResource: input.excelResource }),
    };
  }

  return {
    message: inputToMessage(input),
    model,
    thinkingLevel,
  };
}

/** Distinguishes the resource-bearing Eval wrapper from a standard Runtime message. */
function isAgentEvalInputWithResource(input: AgentEvalInput): input is AgentEvalInputWithResource {
  return typeof input === 'object' && input !== null && 'message' in input;
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
