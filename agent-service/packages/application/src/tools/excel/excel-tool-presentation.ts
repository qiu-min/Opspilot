import type {
  ToolDisplayInfo,
  ToolPresentationContext,
  ToolPresentationResolver,
} from '../../turn/presentation/tool-presentation.js';

/** Creates the business presentation resolver for the Excel tools exposed by this application. */
export function createExcelToolPresentationResolver(): ToolPresentationResolver {
  return resolveExcelToolPresentation;
}

/** Resolves only UI-safe worksheet metadata; internal resource paths are never displayed. */
function resolveExcelToolPresentation(
  context: ToolPresentationContext,
): ToolDisplayInfo | undefined {
  switch (context.name) {
    case 'get_workbook_info':
      return { title: 'Read Workbook' };
    case 'get_sheet_profile': {
      const sheetName = readNonEmptyString(context.arguments.sheetName);
      return sheetName === undefined
        ? { title: 'Inspect Worksheet' }
        : { title: 'Inspect Worksheet', subject: sheetName };
    }
    case 'write_data': {
      const sheetName = readNonEmptyString(context.arguments.sheetName);
      const startCell = readNonEmptyString(context.arguments.startCell);
      return {
        title: 'Write Excel data',
        ...(sheetName === undefined ? {} : { subject: sheetName }),
        ...(startCell === undefined ? {} : { detail: `Starting at ${startCell}` }),
      };
    }
    default:
      return undefined;
  }
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}
