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
    case 'aggregate_data': {
      const sheetName = readNonEmptyString(context.arguments.sheetName);
      const groupBy = readStringArray(context.arguments.groupBy);
      const metricOperations = readMetricOperations(context.arguments.metrics);
      const details = [
        ...(groupBy.length === 0 ? [] : [`Group by ${groupBy.join(', ')}`]),
        ...(metricOperations.length === 0 ? [] : [`Metrics: ${metricOperations.join(', ')}`]),
      ];
      return {
        title: 'Aggregate Excel data',
        ...(sheetName === undefined ? {} : { subject: sheetName }),
        ...(details.length === 0 ? {} : { detail: details.join(' · ') }),
      };
    }
    case 'filter_data': {
      const sheetName = readNonEmptyString(context.arguments.sheetName);
      const conditions = context.arguments.conditions;
      return {
        title: 'Filter Excel data',
        ...(sheetName === undefined ? {} : { subject: sheetName }),
        detail: `Conditions: ${Array.isArray(conditions) ? conditions.length : 0}`,
      };
    }
    case 'read_range': {
      const sheetName = readNonEmptyString(context.arguments.sheetName);
      const range = readNonEmptyString(context.arguments.range);
      return {
        title: 'Read Excel range',
        ...(sheetName === undefined
          ? {}
          : { subject: range === undefined ? sheetName : `${sheetName} · ${range}` }),
        ...(sheetName === undefined && range !== undefined ? { detail: range } : {}),
      };
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

/** Extracts non-empty string values from presentation-only groupBy arguments. */
function readStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

/** Extracts visible metric operations without trusting malformed presentation arguments. */
function readMetricOperations(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((metric) => {
    if (typeof metric !== 'object' || metric === null || !('operation' in metric)) return [];
    return typeof metric.operation === 'string' ? [metric.operation] : [];
  });
}
