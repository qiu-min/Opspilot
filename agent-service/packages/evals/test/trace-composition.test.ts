import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ExecuteTurn, GetTurnTrace } from '@opspilot/application';
import {
  FileSystemExcelSourceResourceStore,
  FileSystemSessionStore,
  FileSystemTurnExecutionContextStore,
  FileSystemTurnStore,
} from '@opspilot/infrastructure';
import {
  createModelEventStream,
  type AssistantMessage,
  type Model,
  type ModelGateway,
} from '@opspilot/model-gateway';
import { describe, expect, it } from 'vitest';

import { AgentEvalExecutor } from '../src/executors/agent-eval-executor.js';
import { EvalRunner } from '../src/core/eval-runner.js';
import { TraceBehaviorEvaluator } from '../src/evaluators/trace-behavior-evaluator.js';

describe('Eval Trace composition', () => {
  it('reads the completed Eval Turn trace from the same FileSystemTurnStore', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'opspilot-evals-trace-composition-'));
    try {
      const turnStore = new FileSystemTurnStore(storageRoot);
      const model = createTestModel();
      const executeTurn = new ExecuteTurn({
        sessionStore: new FileSystemSessionStore(join(storageRoot, 'sessions')),
        excelSourceResourceStore: new FileSystemExcelSourceResourceStore(
          join(storageRoot, 'workspaces'),
        ),
        turnStore,
        turnExecutionContextStore: new FileSystemTurnExecutionContextStore(storageRoot),
        modelGateway: createTestGateway(model),
        defaultModel: model,
        toolDefinitions: [],
      });
      const getTurnTrace = new GetTurnTrace({ turnStore });
      const runner = new EvalRunner({
        executor: new AgentEvalExecutor({ executeTurn }),
        evaluators: [new TraceBehaviorEvaluator({ getTurnTrace })],
      });

      const report = await runner.run({
        id: 'trace-composition-case',
        name: 'Trace composition case',
        input: 'hello',
      });

      expect(report.run.metadata?.turnId).toEqual(expect.any(String));
      expect(report.scores[0]).toMatchObject({
        evaluator: 'trace_behavior',
        score: 1,
        passed: true,
        details: { turnStatus: 'completed', modelCalls: 1 },
      });
      const turnId = report.run.metadata?.turnId;
      if (typeof turnId !== 'string') throw new Error('Expected Eval to expose a turnId.');
      expect(getTurnTrace.execute(turnId)).toMatchObject({
        turnId,
        status: 'completed',
      });
      expect(getTurnTrace.execute(turnId).spans.length).toBeGreaterThan(0);
    } finally {
      await rm(storageRoot, { recursive: true, force: true });
    }
  });
});

/** Creates a minimal valid model descriptor for the composition test. */
function createTestModel(): Model {
  return {
    provider: 'test-provider',
    id: 'test-model',
    name: 'Test Model',
    api: 'test-api',
    baseUrl: 'https://model.example.test/v1',
    reasoning: false,
  };
}

/** Creates a deterministic one-response gateway without any real model access. */
function createTestGateway(model: Model): ModelGateway {
  const response: AssistantMessage = {
    role: 'assistant',
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [{ type: 'text', text: 'hello' }],
    finishReason: 'stop',
    usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
  };
  return {
    getProviders: () => [],
    getModels: () => [model],
    getModel: () => model,
    stream: () =>
      createModelEventStream(async (controller) => {
        controller.emit({
          type: 'start',
          model,
          partial: { ...response, content: [], finishReason: 'pending' },
        });
        controller.complete(response);
      }),
    complete: async () => response,
  };
}
