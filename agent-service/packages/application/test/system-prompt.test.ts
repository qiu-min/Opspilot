import { describe, expect, it } from 'vitest';

import {
  buildOpsPilotSystemPrompt,
  type ToolDefinition,
  withExcelResourceGuidance,
} from '../src/index.js';

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
    expect(prompt).toContain(
      '- Avoid decorative symbols, ornamental separators, and excessive formatting.',
    );
    expect(prompt).toContain(
      '- Use headings, lists, tables, code blocks, and bold text only when they improve readability.',
    );
    expect(prompt).toContain('- Keep formatting proportional to the complexity of the answer.');
  });

  it('does not copy tool descriptions or parameter schemas', () => {
    const prompt = buildOpsPilotSystemPrompt({
      tools: [
        fakeTool('fake_tool', 'SENTINEL_TOOL_DESCRIPTION_SHOULD_NOT_APPEAR', {
          type: 'object',
          properties: { sentinel: { const: 'SENTINEL_PARAMETER_SCHEMA_SHOULD_NOT_APPEAR' } },
        }),
      ],
    });

    expect(prompt).not.toContain('SENTINEL_TOOL_DESCRIPTION_SHOULD_NOT_APPEAR');
    expect(prompt).not.toContain('SENTINEL_PARAMETER_SCHEMA_SHOULD_NOT_APPEAR');
    expect(prompt).not.toContain('fake_tool');
  });

  it('adds workbook grounding guidance when a discovery capability is available', () => {
    const prompt = buildOpsPilotSystemPrompt({ tools: [fakeTool('get_sheet_profile')] });

    expect(prompt).toContain(
      'When workbook-specific facts are required, inspect the workbook before answering.',
    );
  });

  it('explains when the write_data capability is available', () => {
    const prompt = buildOpsPilotSystemPrompt({ tools: [fakeTool('write_data')] });

    expect(prompt).toContain(
      'Use write_data to write structured tabular data into the selected Excel resource.',
    );
    expect(prompt).not.toContain('workingPath');
    expect(prompt).not.toContain('sourcePath');
  });

  it('guides verification after a successful mutation when read_range is available', () => {
    const prompt = buildOpsPilotSystemPrompt({
      tools: [fakeTool('write_data'), fakeTool('read_range')],
    });

    expect(prompt).toContain(
      'After a successful Excel mutation, read back the affected range before reporting completion.',
    );
  });

  it('prefers aggregate and filter tools for large worksheet analysis', () => {
    const prompt = buildOpsPilotSystemPrompt({
      tools: [fakeTool('aggregate_data'), fakeTool('filter_data')],
    });

    expect(prompt).not.toContain('get_workbook_info');
    expect(prompt).not.toContain('get_sheet_profile');
    expect(prompt).toContain(
      'For calculations over many rows, prefer aggregate_data instead of reading raw rows.',
    );
    expect(prompt).toContain('Use filter_data to locate rows matching structured conditions.');
    expect(prompt).toContain('Do not retrieve an entire large worksheet');
  });

  it('mentions only aggregate_data when only aggregate_data is available', () => {
    const prompt = buildOpsPilotSystemPrompt({ tools: [fakeTool('aggregate_data')] });

    expect(prompt).toContain('prefer aggregate_data');
    expect(prompt).not.toContain('Use filter_data');
    expect(prompt).toContain('Do not retrieve an entire large worksheet');
  });

  it('mentions only filter_data when only filter_data is available', () => {
    const prompt = buildOpsPilotSystemPrompt({ tools: [fakeTool('filter_data')] });

    expect(prompt).toContain('Use filter_data');
    expect(prompt).not.toContain('prefer aggregate_data');
    expect(prompt).toContain('Do not retrieve an entire large worksheet');
  });

  it('guides targeted range reads only when read_range is available', () => {
    const prompt = buildOpsPilotSystemPrompt({
      tools: [fakeTool('aggregate_data'), fakeTool('filter_data'), fakeTool('read_range')],
    });
    const withoutReadRange = buildOpsPilotSystemPrompt({
      tools: [fakeTool('aggregate_data'), fakeTool('filter_data')],
    });

    expect(prompt).toContain(
      'Use read_range only for a specific small range when exact cell values are needed.',
    );
    expect(prompt).toContain(
      'Prefer aggregate_data or filter_data for large worksheet analysis, then use read_range for targeted details.',
    );
    expect(prompt).toContain(
      'After filter_data identifies matching row ranges, use read_range on a small relevant range when exact row values are needed.',
    );
    expect(withoutReadRange).not.toContain('read_range');

    const aggregateOnlyPrompt = buildOpsPilotSystemPrompt({
      tools: [fakeTool('aggregate_data'), fakeTool('read_range')],
    });
    expect(aggregateOnlyPrompt).toContain(
      'Prefer aggregate_data for large worksheet analysis, then use read_range for targeted details.',
    );
    expect(aggregateOnlyPrompt).not.toContain('filter_data');
  });

  it('mentions only registered workbook discovery tools', () => {
    const profilePrompt = buildOpsPilotSystemPrompt({ tools: [fakeTool('get_sheet_profile')] });
    const workbookPrompt = buildOpsPilotSystemPrompt({ tools: [fakeTool('get_workbook_info')] });

    expect(profilePrompt).toContain('Use get_sheet_profile');
    expect(profilePrompt).not.toContain('get_workbook_info');
    expect(workbookPrompt).toContain('Use get_workbook_info');
    expect(workbookPrompt).not.toContain('get_sheet_profile');
  });

  it('does not promise workbook inspection without a discovery capability', () => {
    const prompt = buildOpsPilotSystemPrompt({ tools: [] });

    expect(prompt).not.toContain('inspect the workbook before answering');
    expect(prompt).toContain('Never invent worksheet names');
  });

  it('deduplicates additional guidelines and appends extra prompt text', () => {
    const prompt = buildOpsPilotSystemPrompt({
      tools: [],
      additionalGuidelines: [
        "Be concise and focus on the user's actual task.",
        '  Use evidence.  ',
        'Use evidence.',
      ],
      appendSystemPrompt: 'Additional runtime instruction.',
    });

    expect(prompt.match(/Be concise and focus on the user's actual task\./g)).toHaveLength(1);
    expect(prompt.match(/Use evidence\./g)).toHaveLength(1);
    expect(prompt).toContain('Additional runtime instruction.');
  });

  it('adds per-Turn guidance when an Excel workbook is attached', () => {
    const prompt = withExcelResourceGuidance('Base prompt.', true);

    expect(prompt).toContain('This Turn includes an attached Excel workbook.');
    expect(prompt).toContain('call the relevant Excel tool before answering');
    expect(prompt).toContain('Base prompt.');
  });

  it('lists stable resource aliases and the active alias without exposing internal ids or paths', () => {
    const prompt = withExcelResourceGuidance('Base prompt.', {
      resources: [
        { id: 'resource-a', filePath: 'C:/private/a.xlsx' },
        { id: 'resource-b', filePath: 'C:/private/b.xlsx' },
      ],
      excelResourceRefs: [
        { id: 'resource-a', kind: 'excel', alias: 'excel-1' },
        { id: 'resource-b', kind: 'excel', alias: 'excel-2' },
      ],
      activeResourceId: 'resource-b',
    });

    expect(prompt).toContain('Available Excel resources:\n- excel-1\n- excel-2');
    expect(prompt).toContain('Active Excel resource:\n- excel-2');
    expect(prompt).toContain('resource alias in the resource argument');
    expect(prompt).not.toContain('resource-a');
    expect(prompt).not.toContain('resource-b');
    expect(prompt).not.toContain('C:/private');
    expect(prompt).not.toContain('a.xlsx');
    expect(prompt).not.toContain('b.xlsx');
  });

  it('does not add resource guidance when the current Turn has no Excel resources', () => {
    expect(
      withExcelResourceGuidance('Base prompt.', {
        resources: [],
        excelResourceRefs: [],
        activeResourceId: null,
      }),
    ).toBe('Base prompt.');
  });

  it('does not change the prompt when no Excel workbook is attached', () => {
    expect(withExcelResourceGuidance('Base prompt.', false)).toBe('Base prompt.');
  });
});
