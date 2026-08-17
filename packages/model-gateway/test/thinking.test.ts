import { describe, expect, it } from 'vitest';
import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  isModelGatewayError,
  type Model,
} from '../src/index.js';
import { resolveThinking } from '../src/thinking.js';

const model: Model = {
  provider: 'example',
  id: 'reasoner',
  name: 'Reasoner',
  api: 'openai-completions',
  baseUrl: 'https://example.test/v1',
  reasoning: true,
  reasoningProtocol: 'openai-reasoning-effort',
  thinkingLevelMap: { off: 'none', minimal: 'low', medium: 'medium' },
};

describe('ThinkingLevel', () => {
  it('maps K3 levels without selecting its unsupported off value', () => {
    const k3: Model = {
      ...model,
      provider: 'moonshot',
      id: 'kimi-k3',
      thinkingLevelMap: { off: null, minimal: 'low', low: 'low', medium: 'high', high: 'max' },
    };
    expect(resolveThinking(k3, { reasoning: 'minimal' }).resolvedReasoning?.providerValue).toBe(
      'low',
    );
    expect(resolveThinking(k3, { reasoning: 'low' }).resolvedReasoning?.providerValue).toBe('low');
    expect(resolveThinking(k3, { reasoning: 'medium' }).resolvedReasoning?.providerValue).toBe(
      'high',
    );
    expect(resolveThinking(k3, { reasoning: 'high' }).resolvedReasoning?.providerValue).toBe('max');
    expect(getSupportedThinkingLevels(k3)).not.toContain('off');
  });
  it('reports explicitly configured reasoning levels', () => {
    expect(getSupportedThinkingLevels(model)).toEqual(['off', 'minimal', 'medium']);
  });
  it('uses Pi-style upward-then-downward clamping', () => {
    expect(clampThinkingLevel(model, 'low')).toBe('medium');
    expect(clampThinkingLevel(model, 'high')).toBe('medium');
  });
  it('resolves a model-specific Provider value without exposing it to callers', () => {
    expect(resolveThinking(model, { reasoning: 'low' })).toMatchObject({
      reasoning: 'low',
      resolvedReasoning: {
        requested: 'low',
        selected: 'medium',
        providerValue: 'medium',
        protocol: 'openai-reasoning-effort',
      },
    });
  });
  it('never selects a level explicitly marked unsupported', () => {
    const disabledHigh = {
      ...model,
      thinkingLevelMap: { ...model.thinkingLevelMap, high: null },
    };
    expect(clampThinkingLevel(disabledHigh, 'high')).toBe('medium');
    expect(
      resolveThinking(disabledHigh, { reasoning: 'high' }).resolvedReasoning?.providerValue,
    ).toBe('medium');
  });
  it('rejects reasoning requests for models without the capability', () => {
    try {
      resolveThinking({ ...model, reasoning: false }, { reasoning: 'high' });
      throw new Error('Expected reasoning validation to fail.');
    } catch (error) {
      expect(isModelGatewayError(error, 'UNSUPPORTED_CAPABILITY')).toBe(true);
    }
  });
});
