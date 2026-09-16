import type { ExecuteTurnResult, TurnTrace } from '@opspilot/application';

import type { EvalRunResult } from '../core/eval-run-result.js';
import type { EvalScore } from '../core/eval-score.js';
import type { Evaluator } from '../core/evaluator.js';

/** The deliberately small behavior contract supported by the first Trace evaluator. */
export interface TraceBehaviorExpected {
  readonly requiredTools?: readonly string[];
  readonly forbiddenTools?: readonly string[];
  readonly maxToolErrors?: number;
}

/** A stable, application-facing seam for reading a projected TurnTrace. */
export interface TurnTraceReader {
  execute(turnId: string): TurnTrace;
}

export interface TraceBehaviorEvaluatorOptions {
  readonly getTurnTrace: TurnTraceReader;
}

/** Metrics collected from one projected TurnTrace for observation and regression work. */
export interface TraceEvalMetrics {
  readonly turnStatus: string;
  readonly durationMs: number | null;
  readonly modelCalls: number;
  readonly toolCalls: number;
  readonly toolErrors: number;
  readonly retries: number;
  readonly compactions: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly usedTools: readonly string[];
}

/** Evaluates declared Agent behavior rules using durable TurnTrace evidence only. */
export class TraceBehaviorEvaluator implements Evaluator<unknown, ExecuteTurnResult> {
  public readonly name = 'trace_behavior';

  private readonly getTurnTrace: TurnTraceReader;

  /** Creates an evaluator against a minimal Trace reader, keeping infrastructure out of Eval. */
  public constructor(options: TraceBehaviorEvaluatorOptions) {
    this.getTurnTrace = options.getTurnTrace;
  }

  /** Reads Trace, preserves its metrics in the score, and applies optional behavior constraints. */
  public async evaluate(input: {
    readonly expected: unknown;
    readonly actual: ExecuteTurnResult | undefined;
    readonly run: EvalRunResult<ExecuteTurnResult>;
  }): Promise<EvalScore> {
    const turnId = readTurnId(input.run.metadata);
    if (turnId === undefined) {
      return {
        evaluator: this.name,
        score: 0,
        passed: false,
        reason: 'Eval run did not expose a valid turnId for Trace evaluation.',
      };
    }

    const trace = this.getTurnTrace.execute(turnId);
    const metrics = calculateTraceMetrics(trace);
    const behavior = readBehaviorExpected(input.expected);
    const details: Record<string, unknown> = {
      ...metrics,
      ...(behavior?.requiredTools === undefined
        ? {}
        : { requiredTools: behavior.requiredTools }),
      ...(behavior?.forbiddenTools === undefined
        ? {}
        : { forbiddenTools: behavior.forbiddenTools }),
      ...(behavior?.maxToolErrors === undefined
        ? {}
        : { maxToolErrors: behavior.maxToolErrors }),
    };

    if (behavior === undefined) return pass(details);

    for (const requiredTool of behavior.requiredTools ?? []) {
      const completedSuccessfully = trace.spans.some(
        (span) =>
          span.kind === 'tool' &&
          span.name === requiredTool &&
          span.status === 'completed' &&
          span.isError === false,
      );
      if (!completedSuccessfully) {
        return fail(`Required tool ${requiredTool} did not complete successfully.`, details);
      }
    }

    for (const forbiddenTool of behavior.forbiddenTools ?? []) {
      const wasExecuted = trace.spans.some(
        (span) => span.kind === 'tool' && span.name === forbiddenTool,
      );
      if (wasExecuted) return fail(`Forbidden tool ${forbiddenTool} was executed.`, details);
    }

    if (behavior.maxToolErrors !== undefined && metrics.toolErrors > behavior.maxToolErrors) {
      return fail(
        `Expected at most ${behavior.maxToolErrors} tool errors but Trace contained ${metrics.toolErrors}.`,
        details,
      );
    }

    return pass(details);
  }
}

/** Computes deterministic metrics without inspecting ExecuteTurnResult messages. */
function calculateTraceMetrics(trace: TurnTrace): TraceEvalMetrics {
  let modelCalls = 0;
  let toolCalls = 0;
  let toolErrors = 0;
  let retries = 0;
  let compactions = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  const usedTools: string[] = [];
  const seenTools = new Set<string>();

  for (const span of trace.spans) {
    if (span.kind === 'model') {
      modelCalls += 1;
      retries += span.retries.length;
      if (span.usage !== null) {
        inputTokens += span.usage.inputTokens;
        outputTokens += span.usage.outputTokens;
        totalTokens += span.usage.totalTokens;
      }
      continue;
    }

    if (span.kind === 'tool') {
      toolCalls += 1;
      if (span.isError || span.status === 'error') toolErrors += 1;
      if (!seenTools.has(span.name)) {
        seenTools.add(span.name);
        usedTools.push(span.name);
      }
      continue;
    }

    compactions += 1;
  }

  return {
    turnStatus: trace.status,
    durationMs: trace.durationMs,
    modelCalls,
    toolCalls,
    toolErrors,
    retries,
    compactions,
    inputTokens,
    outputTokens,
    totalTokens,
    usedTools,
  };
}

/** Reads only a non-blank turn ID from the executor metadata boundary. */
function readTurnId(metadata: Readonly<Record<string, unknown>> | undefined): string | undefined {
  const turnId = metadata?.turnId;
  return typeof turnId === 'string' && turnId.trim().length > 0 ? turnId : undefined;
}

/** Reads the validated dataset behavior object without coupling the evaluator to its loader. */
function readBehaviorExpected(value: unknown): TraceBehaviorExpected | undefined {
  if (!isRecord(value) || value.behavior === undefined || !isRecord(value.behavior)) {
    return undefined;
  }

  const behavior = value.behavior;
  return {
    ...(behavior.requiredTools === undefined
      ? {}
      : { requiredTools: behavior.requiredTools as readonly string[] }),
    ...(behavior.forbiddenTools === undefined
      ? {}
      : { forbiddenTools: behavior.forbiddenTools as readonly string[] }),
    ...(behavior.maxToolErrors === undefined ? {} : { maxToolErrors: behavior.maxToolErrors as number }),
  };
}

/** Creates a passing score while retaining all Trace facts in details. */
function pass(details: Readonly<Record<string, unknown>>): EvalScore {
  return { evaluator: 'trace_behavior', score: 1, passed: true, details };
}

/** Creates a failing score while retaining all Trace facts in details. */
function fail(reason: string, details: Readonly<Record<string, unknown>>): EvalScore {
  return { evaluator: 'trace_behavior', score: 0, passed: false, reason, details };
}

/** Checks an unknown expected payload without widening it to an unsafe type. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
