import type { ToolDefinition } from '../tools/tool-definition.js';

const WORKBOOK_DISCOVERY_TOOL_NAMES = new Set([
  'get_workbook_info',
  'get_sheet_profile',
]);

const BASE_GUIDELINES = [
  "Respond in the user's language unless they ask otherwise.",
  "Be concise and focus on the user's actual task.",
  'Never invent worksheet names, cell values, formulas, ranges, statistics, or workbook structure.',
  'Ground workbook-specific claims in observed tool results.',
  'Distinguish observed facts from interpretation or recommendations.',
  'Use only the tool calls necessary to complete the task.',
  'If available capabilities cannot obtain the required information, state the limitation clearly.',
  'Never claim an action was performed unless an available tool actually performed it.',
] as const;

const WORKBOOK_GROUNDING_GUIDELINE =
  'When workbook-specific facts are required, inspect the workbook before answering.';

export interface BuildOpsPilotSystemPromptOptions {
  readonly tools: readonly ToolDefinition[];
  readonly additionalGuidelines?: readonly string[];
  readonly appendSystemPrompt?: string;
}

/** Builds the stable OpsPilot behavior policy for the capabilities of one runtime. */
export function buildOpsPilotSystemPrompt(
  options: BuildOpsPilotSystemPromptOptions,
): string {
  const toolNames = new Set(options.tools.map((tool) => tool.name));
  const guidelines: string[] = [];
  const seen = new Set<string>();

  const addGuideline = (value: string): void => {
    const normalized = value.trim();
    if (normalized.length === 0 || seen.has(normalized)) return;

    seen.add(normalized);
    guidelines.push(normalized);
  };

  for (const guideline of BASE_GUIDELINES) {
    addGuideline(guideline);
  }

  if ([...WORKBOOK_DISCOVERY_TOOL_NAMES].some((toolName) => toolNames.has(toolName))) {
    addGuideline(WORKBOOK_GROUNDING_GUIDELINE);
  }

  for (const guideline of options.additionalGuidelines ?? []) {
    addGuideline(guideline);
  }

  const sections = [
    'You are OpsPilot, an AI assistant for spreadsheet analysis and operational workflows.',
    '',
    'Guidelines:',
    guidelines.map((guideline) => `- ${guideline}`).join('\n'),
  ];
  const appendSystemPrompt = options.appendSystemPrompt?.trim();
  if (appendSystemPrompt !== undefined && appendSystemPrompt.length > 0) {
    sections.push('', appendSystemPrompt);
  }

  return sections.join('\n');
}
