import { describe, expect, it } from 'vitest';

import { buildOpsPilotSystemPrompt, type ToolDefinition } from '../src/index.js';

function fakeTool(
  name: string,
  description = 'Tool description that must stay out of the system prompt.',
  parameters: ToolDefinition['parameters'] = {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
): ToolDefinition {
  return {
    name,
    description,
    parameters,
    async execute() {
      return { content: [] };
    },
  };
}

describe('buildOpsPilotSystemPrompt', () => {
  it('builds the base identity and reliability guidelines', () => {
    const prompt = buildOpsPilotSystemPrompt({ tools: [] });

    expect(prompt).toContain('You are OpsPilot');
    expect(prompt).toContain('Guidelines:');
    expect(prompt).toContain('Never invent worksheet names');
    expect(prompt).toContain('state the limitation clearly');
    expect(prompt).toContain('Response style:');
    expect(prompt).toContain('- Use clear, concise, and professional language.');
    expect(prompt).toContain('- Prefer plain prose and simple Markdown.');
    expect(prompt).toContain('- Do not use emojis unless explicitly requested.');
    expect(prompt).toContain('- Avoid decorative symbols, ornamental separators, and excessive formatting.');
    expect(prompt).toContain('- Use headings, lists, tables, code blocks, and bold text only when they improve readability.');
    expect(prompt).toContain('- Keep formatting proportional to the complexity of the answer.');
  });

  it('does not copy tool descriptions or parameter schemas', () => {
    const prompt = buildOpsPilotSystemPrompt({
      tools: [
        fakeTool(
          'fake_tool',
          'SENTINEL_TOOL_DESCRIPTION_SHOULD_NOT_APPEAR',
          { type: 'object', properties: { sentinel: { const: 'SENTINEL_PARAMETER_SCHEMA_SHOULD_NOT_APPEAR' } } },
        ),
      ],
    });

    expect(prompt).not.toContain('SENTINEL_TOOL_DESCRIPTION_SHOULD_NOT_APPEAR');
    expect(prompt).not.toContain('SENTINEL_PARAMETER_SCHEMA_SHOULD_NOT_APPEAR');
    expect(prompt).not.toContain('fake_tool');
  });

  it('adds workbook grounding guidance when a discovery capability is available', () => {
    const prompt = buildOpsPilotSystemPrompt({ tools: [fakeTool('get_sheet_profile')] });

    expect(prompt).toContain('When workbook-specific facts are required, inspect the workbook before answering.');
  });

  it('does not promise workbook inspection without a discovery capability', () => {
    const prompt = buildOpsPilotSystemPrompt({ tools: [] });

    expect(prompt).not.toContain('inspect the workbook before answering');
    expect(prompt).toContain('Never invent worksheet names');
  });

  it('deduplicates additional guidelines and appends extra prompt text', () => {
    const prompt = buildOpsPilotSystemPrompt({
      tools: [],
      additionalGuidelines: ['Be concise and focus on the user\'s actual task.', '  Use evidence.  ', 'Use evidence.'],
      appendSystemPrompt: 'Additional runtime instruction.',
    });

    expect(prompt.match(/Be concise and focus on the user's actual task\./g)).toHaveLength(1);
    expect(prompt.match(/Use evidence\./g)).toHaveLength(1);
    expect(prompt).toContain('Additional runtime instruction.');
  });
});
