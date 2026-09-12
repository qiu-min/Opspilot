import type {
  ToolDisplayInfo,
  ToolPresentationContext,
  ToolPresentationResolver,
} from '@opspilot/application';

/** Creates the business presentation resolver for the Excel tools exposed by this runtime. */
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
    default:
      return undefined;
  }
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}
