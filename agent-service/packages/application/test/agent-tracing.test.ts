import { describe, expect, it } from 'vitest';
import {
  Agent,
  type AgentAttributeValue,
  type AgentSpan,
  type AgentSpanOptions,
  type AgentTracer,
} from '@opspilot/agent-runtime';
import { createModelEventStream, type AssistantMessage, type Model } from '@opspilot/model-gateway';

import {
  AgentSession,
  buildSessionContext,
  type CompactionService,
  type CompactionSettings,
  Session,
} from '../src/index.js';

const model: Model = {
  provider: 'test-provider',
  id: 'test-model',
  name: 'Test Model',
  api: 'test-api',
  baseUrl: 'https://model.example.test/v1',
  contextWindow: 40,
  reasoning: false,
};

interface SpanRecord {
  readonly name: string;
  readonly attributes: Record<string, AgentAttributeValue>;
  ended: boolean;
}

/** Records Application-level compaction spans without depending on OpenTelemetry. */
class RecordingTracer implements AgentTracer {
  public readonly spans: SpanRecord[] = [];

  /** Runs an operation in a recording span and closes it in finally. */
  public async withSpan<T>(
    name: string,
    options: AgentSpanOptions,
    operation: (span: AgentSpan) => Promise<T>,
  ): Promise<T> {
    const record: SpanRecord = {
      name,
      attributes: { ...(options.attributes ?? {}) },
      ended: false,
    };
    this.spans.push(record);
    try {
      return await operation({
        setAttribute: (key, value) => {
          record.attributes[key] = value;
        },
        setAttributes: (attributes) => {
          Object.assign(record.attributes, attributes);
        },
        recordException: () => undefined,
        setStatus: () => undefined,
      });
    } finally {
      record.ended = true;
    }
  }
}

/** Creates an assistant response used by the Runtime model stream. */
function assistantMessage(text: string): AssistantMessage {
  return {
    role: 'assistant',
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: text.length === 0 ? [] : [{ type: 'text', text }],
    finishReason: 'stop',
  };
}

/** Creates a one-response model stream. */
function assistantStream(message: AssistantMessage) {
  return createModelEventStream(async (controller) => {
    controller.emit({
      type: 'start',
      model,
      partial: { ...message, content: [], finishReason: 'pending' },
    });
    controller.complete(message);
  });
}

/** Creates a minimal CompactionService for span lifecycle tests. */
function createCompactionService(): CompactionService {
  return {
    compact: async () => ({ summary: 'summary' }),
  };
}

const compactionSettings: CompactionSettings = {
  enabled: true,
  reserveTokens: 0,
  keepRecentTokens: 1,
};

describe('Application tracing integration', () => {
  it('creates compaction telemetry only for an actual compaction operation', async () => {
    const session = Session.create();
    session.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: 'x'.repeat(200) }],
    });
    session.appendMessage(assistantMessage('recent response'));
    const tracer = new RecordingTracer();
    const agent = new Agent({
      model,
      tracer,
      messages: buildSessionContext(session).messages,
      streamFn: () => assistantStream(assistantMessage('done')),
    });
    const agentSession = new AgentSession({
      agent,
      session,
      tracer,
      compactionService: createCompactionService(),
      compactionSettings,
    });

    await agentSession.prompt({
      role: 'user',
      content: [{ type: 'text', text: 'continue' }],
    });

    const compactionSpan = tracer.spans.find((span) => span.name === 'agent.compaction');
    expect(compactionSpan?.attributes).toEqual({
      'agent.compaction.reason': 'threshold',
    });
    expect(compactionSpan?.ended).toBe(true);
    expect(tracer.spans.map((span) => span.name)).toEqual([
      'agent.compaction',
      'agent.run',
      'agent.model_call',
    ]);
  });

  it('does not create a compaction span when no compaction is needed', async () => {
    const session = Session.create();
    const tracer = new RecordingTracer();
    const agentSession = new AgentSession({
      agent: new Agent({
        model,
        tracer,
        messages: buildSessionContext(session).messages,
        streamFn: () => assistantStream(assistantMessage('done')),
      }),
      session,
      tracer,
      compactionService: createCompactionService(),
      compactionSettings,
    });

    await agentSession.prompt({
      role: 'user',
      content: [{ type: 'text', text: 'no compaction' }],
    });

    expect(tracer.spans.some((span) => span.name === 'agent.compaction')).toBe(false);
  });
});
