import {
  context,
  SpanStatusCode,
  trace,
  type Attributes,
  type Span,
  type Tracer,
} from '@opentelemetry/api';

import type {
  AgentAttributeValue,
  AgentAttributes,
  AgentSpan,
  AgentSpanOptions,
  AgentSpanStatus,
  AgentTracer,
} from '@opspilot/agent-runtime';

/** Default instrumentation scope used for OpsPilot Agent Runtime spans. */
export const OPSPILOT_AGENT_RUNTIME_INSTRUMENTATION_SCOPE = 'opspilot.agent-runtime';

/** Optional dependencies for the OpenTelemetry AgentTracer adapter. */
export interface OpenTelemetryAgentTracerOptions {
  /** A test or application-provided OTel tracer; defaults to the global provider. */
  readonly tracer?: Tracer;
  /** OTel instrumentation scope name used when resolving the global tracer. */
  readonly instrumentationScopeName?: string;
}

/** Adapts the Runtime tracing port to the OpenTelemetry API. */
export class OpenTelemetryAgentTracer implements AgentTracer {
  private readonly tracer: Tracer;

  /** Creates an adapter without configuring an exporter or SDK provider. */
  public constructor(options: OpenTelemetryAgentTracerOptions = {}) {
    this.tracer =
      options.tracer ??
      trace.getTracer(
        options.instrumentationScopeName ?? OPSPILOT_AGENT_RUNTIME_INSTRUMENTATION_SCOPE,
      );
  }

  /** Starts a span, activates it for nested async work, and always ends it. */
  public async withSpan<T>(
    name: string,
    options: AgentSpanOptions,
    operation: (span: AgentSpan) => Promise<T>,
  ): Promise<T> {
    const span = this.tracer.startSpan(name, {
      attributes: toOtelAttributes(options.attributes),
    });
    const activeContext = trace.setSpan(context.active(), span);
    const agentSpan = new OpenTelemetryAgentSpan(span);
    try {
      return await context.with(activeContext, async () => {
        return await operation(agentSpan);
      });
    } catch (error: unknown) {
      if (!agentSpan.hasErrorStatus) {
        agentSpan.recordException(error);
        agentSpan.setStatus('error', getExceptionMessage(error));
      }
      throw error;
    } finally {
      try {
        span.end();
      } catch {
        // A provider shutdown or implementation failure must not alter Runtime behavior.
      }
    }
  }
}

/** Wraps an OTel span behind the provider-neutral Runtime span contract. */
class OpenTelemetryAgentSpan implements AgentSpan {
  private errorStatus = false;

  /** Creates an adapter around one OTel span. */
  public constructor(private readonly span: Span) {}

  /** Reports whether Runtime already marked this span as failed. */
  public get hasErrorStatus(): boolean {
    return this.errorStatus;
  }

  /** Safely forwards one attribute to OTel. */
  public setAttribute(key: string, value: AgentAttributeValue): void {
    try {
      this.span.setAttribute(key, toOtelAttributeValue(value));
    } catch {
      // Telemetry is optional and must never change Agent execution semantics.
    }
  }

  /** Safely forwards several attributes to OTel. */
  public setAttributes(attributes: AgentAttributes): void {
    try {
      this.span.setAttributes(toOtelAttributes(attributes));
    } catch {
      // Telemetry is optional and must never change Agent execution semantics.
    }
  }

  /** Safely records an OTel-compatible representation of an unknown exception. */
  public recordException(exception: unknown): void {
    this.errorStatus = true;
    try {
      this.span.recordException(toOtelException(exception));
    } catch {
      // Telemetry is optional and must never change Agent execution semantics.
    }
  }

  /** Safely maps Runtime status values to OTel status codes. */
  public setStatus(status: AgentSpanStatus, message?: string): void {
    if (status === 'error') this.errorStatus = true;
    try {
      this.span.setStatus({
        code:
          status === 'error'
            ? SpanStatusCode.ERROR
            : status === 'ok'
              ? SpanStatusCode.OK
              : SpanStatusCode.UNSET,
        ...(message === undefined ? {} : { message }),
      });
    } catch {
      // Telemetry is optional and must never change Agent execution semantics.
    }
  }
}

/** Converts Runtime attributes to mutable OTel attribute arrays. */
function toOtelAttributes(attributes: AgentAttributes | undefined): Attributes {
  if (attributes === undefined) return {};

  const result: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    result[key] = toOtelAttributeValue(value);
  }
  return result;
}

/** Converts one provider-neutral attribute value to the OTel representation. */
function toOtelAttributeValue(value: AgentAttributeValue): string | number | boolean {
  return value;
}

/** Converts arbitrary Runtime exceptions into the OTel exception contract. */
function toOtelException(exception: unknown): Error | string {
  if (exception instanceof Error || typeof exception === 'string') return exception;
  return exception === undefined ? 'Unknown exception.' : String(exception);
}

/** Converts an unknown operation failure into an OTel status message. */
function getExceptionMessage(exception: unknown): string | undefined {
  if (exception instanceof Error) return exception.message;
  if (typeof exception === 'string') return exception;
  if (exception === undefined || exception === null) return undefined;
  return String(exception);
}
