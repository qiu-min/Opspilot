import type { ToolDefinition } from '../tools/tool-definition.js';
import type { ExcelResourceContext } from '../resources/excel/excel-resource-context.js';

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
const WRITE_DATA_GUIDELINE =
  'Use write_data to write structured tabular data into the selected Excel resource.';
const READ_RANGE_GUIDELINE =
  'Use read_range only for a specific small range when exact cell values are needed.';
const FILTERED_RANGE_DETAIL_GUIDELINE =
  'After filter_data identifies matching row ranges, use read_range on a small relevant range when exact row values are needed.';
const LARGE_WORKSHEET_ANALYSIS_GUIDELINE =
  'Do not retrieve an entire large worksheet just to calculate totals, averages, counts, min/max, grouping, or filtering.';

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

  const hasWorkbookInfo = toolNames.has('get_workbook_info');
  const hasSheetProfile = toolNames.has('get_sheet_profile');
  if (hasWorkbookInfo || hasSheetProfile) {
    addGuideline(WORKBOOK_GROUNDING_GUIDELINE);
    if (hasWorkbookInfo && hasSheetProfile) {
      addGuideline('Use get_workbook_info and get_sheet_profile to inspect workbook structure.');
    } else if (hasWorkbookInfo) {
      addGuideline('Use get_workbook_info to inspect workbook structure.');
    } else {
      addGuideline('Use get_sheet_profile to inspect worksheet structure.');
    }
  }
  if (toolNames.has('write_data')) addGuideline(WRITE_DATA_GUIDELINE);
  const hasAggregateData = toolNames.has('aggregate_data');
  const hasFilterData = toolNames.has('filter_data');
  if (hasAggregateData) {
    addGuideline(
      'For calculations over many rows, prefer aggregate_data instead of reading raw rows.',
    );
  }
  if (hasFilterData) addGuideline('Use filter_data to locate rows matching structured conditions.');
  if (hasAggregateData || hasFilterData) addGuideline(LARGE_WORKSHEET_ANALYSIS_GUIDELINE);
  const hasReadRange = toolNames.has('read_range');
  if (hasReadRange) addGuideline(READ_RANGE_GUIDELINE);
  if (hasReadRange && (hasAggregateData || hasFilterData)) {
    const largeDataTools = [
      ...(hasAggregateData ? ['aggregate_data'] : []),
      ...(hasFilterData ? ['filter_data'] : []),
    ];
    addGuideline(
      `Prefer ${largeDataTools.join(' or ')} for large worksheet analysis, then use read_range for targeted details.`,
    );
  }
  if (hasReadRange && hasFilterData) addGuideline(FILTERED_RANGE_DETAIL_GUIDELINE);

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
