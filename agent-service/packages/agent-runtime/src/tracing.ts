/** Values accepted by the runtime tracing contract as span attributes. */
export type AgentAttributePrimitive = string | number | boolean;

/** A provider-neutral attribute value supported by the runtime tracing contract. */
export type AgentAttributeValue = AgentAttributePrimitive;

/** A provider-neutral set of span attributes. */
export type AgentAttributes = Readonly<Record<string, AgentAttributeValue>>;

/** Options used when starting a runtime span. */
export interface AgentSpanOptions {
  readonly attributes?: AgentAttributes;
}

/** Minimal span operations needed by Agent Runtime instrumentation. */
export interface AgentSpan {
  /** Sets one span attribute. Instrumentation failures must not escape this method. */
  setAttribute(key: string, value: AgentAttributeValue): void;
  /** Sets several span attributes. Instrumentation failures must not escape this method. */
  setAttributes(attributes: AgentAttributes): void;
  /** Records an exception without exposing a telemetry vendor type to Runtime. */
  recordException(exception: unknown): void;
  /** Sets the provider-neutral span status. */
  setStatus(status: AgentSpanStatus, message?: string): void;
}

/** Provider-neutral span status values. */
export type AgentSpanStatus = 'unset' | 'ok' | 'error';

/** Generic tracing port consumed by Agent Runtime and implemented by adapters. */
export interface AgentTracer {
  /** Runs an operation in the active span scope and ends the span in the adapter. */
  withSpan<T>(
    name: string,
    options: AgentSpanOptions,
    operation: (span: AgentSpan) => Promise<T>,
  ): Promise<T>;
}

const NOOP_AGENT_SPAN: AgentSpan = {
  setAttribute: () => undefined,
  setAttributes: () => undefined,
  recordException: () => undefined,
  setStatus: () => undefined,
};

/** No-op tracer used when the application has no telemetry provider configured. */
export class NoopAgentTracer implements AgentTracer {
  /** Executes the callback without allocating or recording a span. */
  public async withSpan<T>(
    _name: string,
    _options: AgentSpanOptions,
    operation: (span: AgentSpan) => Promise<T>,
  ): Promise<T> {
    return await operation(NOOP_AGENT_SPAN);
  }
}

/** Shared no-op instance used as the Runtime default. */
export const NOOP_AGENT_TRACER: AgentTracer = new NoopAgentTracer();

/**
 * Executes a traced operation while isolating tracer failures from Agent execution.
 * The original operation error is rethrown unchanged; a tracer failure falls back to
 * running the operation with the no-op span.
 */
export async function withAgentSpan<T>(
  tracer: AgentTracer | undefined,
  name: string,
  options: AgentSpanOptions,
  operation: (span: AgentSpan) => Promise<T>,
): Promise<T> {
  const selectedTracer = tracer ?? NOOP_AGENT_TRACER;
  let callbackEntered = false;
  let operationCompleted = false;
  let operationFailed = false;
  let operationResult!: T;
  let operationError: unknown;

  try {
    return await selectedTracer.withSpan(name, options, async (span) => {
      callbackEntered = true;
      try {
        const result = await operation(new SafeAgentSpan(span));
        operationResult = result;
        operationCompleted = true;
        return result;
      } catch (error: unknown) {
        operationError = error;
        operationFailed = true;
        throw error;
      }
    });
  } catch (error: unknown) {
    if (operationFailed) throw operationError;
    if (operationCompleted) return operationResult;
    if (!callbackEntered) return await operation(NOOP_AGENT_SPAN);
    throw error;
  }
}

/** Marks a failed operation without allowing telemetry calls to alter control flow. */
export function markAgentSpanError(
  span: AgentSpan,
  exception: unknown,
  options?: { readonly aborted?: boolean },
): void {
  const message = getExceptionMessage(exception);
  if (options?.aborted === true) {
    span.setAttribute('agent.operation.cancelled', true);
    span.setStatus('error', message);
    return;
  }

  span.recordException(exception);
  span.setStatus('error', message);
}

/** Marks cancellation without recording a synthetic telemetry exception. */
export function markAgentSpanAborted(span: AgentSpan, message?: string): void {
  span.setAttribute('agent.operation.cancelled', true);
  span.setStatus('error', message);
}

/** Converts an unknown thrown value into a stable status message. */
function getExceptionMessage(exception: unknown): string | undefined {
  if (exception instanceof Error) return exception.message;
  if (typeof exception === 'string') return exception;
  if (exception === undefined || exception === null) return undefined;
  return String(exception);
}

/** Guards an injected span so a broken telemetry implementation cannot break Runtime work. */
class SafeAgentSpan implements AgentSpan {
  /** Creates a guarded view over an injected span. */
  public constructor(private readonly delegate: AgentSpan) {}

  /** Safely sets one attribute. */
  public setAttribute(key: string, value: AgentAttributeValue): void {
    try {
      this.delegate.setAttribute(key, value);
    } catch {
      // Telemetry is optional and must never change Agent execution semantics.
    }
  }

  /** Safely sets several attributes. */
  public setAttributes(attributes: AgentAttributes): void {
    try {
      this.delegate.setAttributes(attributes);
    } catch {
      // Telemetry is optional and must never change Agent execution semantics.
    }
  }

  /** Safely records an exception. */
  public recordException(exception: unknown): void {
    try {
      this.delegate.recordException(exception);
    } catch {
      // Telemetry is optional and must never change Agent execution semantics.
    }
  }

  /** Safely sets span status. */
  public setStatus(status: AgentSpanStatus, message?: string): void {
    try {
      this.delegate.setStatus(status, message);
    } catch {
      // Telemetry is optional and must never change Agent execution semantics.
    }
  }
}
