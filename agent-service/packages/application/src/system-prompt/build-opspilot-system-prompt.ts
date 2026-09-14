import type { ToolDefinition } from '../tools/tool-definition.js';
import type { ExcelResourceContext } from '../resources/excel/excel-resource-context.js';

const WORKBOOK_DISCOVERY_TOOL_NAMES = new Set(['get_workbook_info', 'get_sheet_profile']);

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

const RESPONSE_STYLE_GUIDELINES = [
  'Use clear, concise, and professional language.',
  'Prefer plain prose and simple Markdown.',
  'Do not use emojis unless explicitly requested.',
  'Avoid decorative symbols, ornamental separators, and excessive formatting.',
  'Use headings, lists, tables, code blocks, and bold text only when they improve readability.',
  'Keep formatting proportional to the complexity of the answer.',
] as const;

export interface BuildOpsPilotSystemPromptOptions {
  readonly tools: readonly ToolDefinition[];
  readonly additionalGuidelines?: readonly string[];
  readonly appendSystemPrompt?: string;
}

/** Builds the stable OpsPilot behavior policy for the capabilities of one runtime. */
export function buildOpsPilotSystemPrompt(options: BuildOpsPilotSystemPromptOptions): string {
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
    '',
    'Response style:',
    RESPONSE_STYLE_GUIDELINES.map((guideline) => `- ${guideline}`).join('\n'),
  ];
  const appendSystemPrompt = options.appendSystemPrompt?.trim();
  if (appendSystemPrompt !== undefined && appendSystemPrompt.length > 0) {
    sections.push('', appendSystemPrompt);
  }

  return sections.join('\n');
}

/** Adds per-Turn resource state without exposing the server-side file path to the model. */
export function withExcelResourceGuidance(
  systemPrompt: string | undefined,
  resourceContext:
    Pick<ExcelResourceContext, 'resources' | 'excelResourceRefs' | 'activeResourceId'> | boolean,
): string | undefined {
  const basePrompt = systemPrompt?.trim();
  const appendGuidance = (guidance: string): string =>
    basePrompt === undefined || basePrompt.length === 0 ? guidance : `${basePrompt}\n\n${guidance}`;

  if (typeof resourceContext === 'boolean') {
    if (!resourceContext) return systemPrompt;

    return appendGuidance(
      'This Turn includes an attached Excel workbook. The workbook is available through the Excel tools. When the user asks to inspect or analyze the workbook, call the relevant Excel tool before answering; do not say that no workbook is attached.',
    );
  }

  if (resourceContext.resources.length === 0) return systemPrompt;

  const availableResourceRefs = resourceContext.excelResourceRefs.filter((resourceRef) =>
    resourceContext.resources.some((resource) => resource.id === resourceRef.id),
  );
  const activeResourceAlias = availableResourceRefs.find(
    (resourceRef) => resourceRef.id === resourceContext.activeResourceId,
  )?.alias;
  const guidance = [
    resourceContext.resources.length === 1
      ? 'This Turn includes an attached Excel workbook. When the user asks to inspect or analyze it, call the relevant Excel tool before answering.'
      : 'This Turn includes multiple Excel resources. When the user asks to inspect or analyze a workbook, call the relevant Excel tool before answering.',
    'Available Excel resources:',
    ...availableResourceRefs.map((resourceRef) => `- ${resourceRef.alias}`),
    ...(activeResourceAlias !== undefined
      ? ['Active Excel resource:', `- ${activeResourceAlias}`]
      : []),
    ...(resourceContext.resources.length > 1
      ? [
          'When operating on a specific workbook, pass its resource alias in the resource argument to the Excel tool.',
        ]
      : []),
  ].join('\n');

  return appendGuidance(guidance);
}
