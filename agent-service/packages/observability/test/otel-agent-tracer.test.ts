import { describe, expect, it } from 'vitest';
import type { Span, Tracer } from '@opentelemetry/api';

import { OpenTelemetryAgentTracer, type OpenTelemetryAgentTracerOptions } from '../src/index.js';

interface CapturedSpan {
  readonly name: string;
  readonly attributes: Record<string, unknown>;
  readonly exceptions: unknown[];
  readonly statuses: Array<{ readonly code: number; readonly message?: string }>;
  ended: number;
}

/** Creates the minimal OTel Span surface needed to verify the adapter boundary. */
function createCapturedSpan(name: string): { span: Span; record: CapturedSpan } {
  const record: CapturedSpan = {
    name,
    attributes: {},
    exceptions: [],
    statuses: [],
    ended: 0,
  };
  const span = {
    setAttribute: (key: string, value: unknown) => {
      record.attributes[key] = value;
      return span;
    },
    setAttributes: (attributes: Record<string, unknown>) => {
      Object.assign(record.attributes, attributes);
      return span;
    },
    recordException: (exception: unknown) => {
      record.exceptions.push(exception);
      return span;
    },
    setStatus: (status: { readonly code: number; readonly message?: string }) => {
      record.statuses.push(status);
      return span;
    },
    end: () => {
      record.ended += 1;
    },
  } as unknown as Span;
  return { span, record };
}

describe('OpenTelemetryAgentTracer', () => {
  it('maps Runtime spans to OTel and always ends the span', async () => {
    const captured = createCapturedSpan('agent.run');
    const tracer = {
      startSpan: (_name: string, options: { readonly attributes?: Record<string, unknown> }) => {
        Object.assign(captured.record.attributes, options.attributes ?? {});
        return captured.span;
      },
    } as unknown as Tracer;
    const options: OpenTelemetryAgentTracerOptions = { tracer };
    const adapter = new OpenTelemetryAgentTracer(options);

    await adapter.withSpan(
      'agent.run',
      { attributes: { 'agent.run.id': 'run-1' } },
      async (span) => {
        span.setAttribute('agent.test', true);
        span.recordException(new Error('expected'));
        span.setStatus('error', 'failed');
        return 'result';
      },
    );

    expect(captured.record.attributes).toEqual({
      'agent.run.id': 'run-1',
      'agent.test': true,
    });
    expect(captured.record.exceptions).toHaveLength(1);
    expect(captured.record.statuses).toHaveLength(1);
    expect(captured.record.ended).toBe(1);
  });

  it('preserves the original operation error while ending the span', async () => {
    const captured = createCapturedSpan('agent.model_call');
    const tracer = {
      startSpan: () => captured.span,
    } as unknown as Tracer;
    const adapter = new OpenTelemetryAgentTracer({ tracer });
    const failure = new Error('model failure');

    await expect(
      adapter.withSpan('agent.model_call', {}, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(captured.record.exceptions).toEqual([failure]);
    expect(captured.record.statuses).toHaveLength(1);
    expect(captured.record.ended).toBe(1);
  });
});
