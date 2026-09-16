import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { EvalCase } from '../core/eval-case.js';
import type { AgentEvalInput } from '../executors/agent-eval-executor.js';
import type { TraceBehaviorExpected } from '../evaluators/trace-behavior-evaluator.js';

/** Fixed, checked-in expected facts for one Excel Golden Case. */
export interface ExcelGoldenCaseExpected {
  readonly sheetCount?: number;
  readonly sheetRows?: readonly ExcelGoldenSheetRowsExpected[];
  readonly topRegionSales?: ExcelGoldenTopRegionSalesExpected;
  readonly workbookMutation?: ExcelGoldenWorkbookMutationExpected;
  readonly behavior?: TraceBehaviorExpected;
}

/** Fixed expected data/header row counts for one worksheet in an Excel Golden Case. */
export interface ExcelGoldenSheetRowsExpected {
  readonly sheetName: string;
  readonly dataRowCount: number;
  readonly headerRowCount: number;
}

/** Fixed regional sales aggregate expected by the Excel top-region Golden Case. */
export interface ExcelGoldenTopRegionSalesExpected {
  readonly sheetName: string;
  readonly region: string;
  readonly totalSales: number;
  readonly orderCount: number;
}

/** Fixed worksheet range values expected after a workbook mutation Golden Case. */
export interface ExcelGoldenWorkbookMutationExpected {
  readonly sheetName: string;
  readonly range: string;
  readonly expectedValues: readonly (readonly unknown[])[];
}

/** Parsed Excel Golden Case returned by the dataset loader. */
export type ExcelGoldenCase = EvalCase<AgentEvalInput, ExcelGoldenCaseExpected>;

interface ExcelGoldenCaseRecord {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly input: string;
  readonly workbook: string;
  readonly expected: ExcelGoldenCaseExpected;
  readonly tags: readonly string[];
}

const defaultDatasetPath = fileURLToPath(
  new URL('../../datasets/excel/cases.json', import.meta.url),
);
const excelDatasetDirectory = resolve(
  fileURLToPath(new URL('../../datasets/excel/', import.meta.url)),
);
const excelResourceId = 'excel-sales-workbook';

/** Loads and validates checked-in Excel Golden Cases with safe fixture resolution. */
export async function loadExcelCases(
  datasetPath: string = defaultDatasetPath,
): Promise<readonly ExcelGoldenCase[]> {
  const raw = JSON.parse(await readFile(datasetPath, 'utf8')) as unknown;
  if (!Array.isArray(raw)) throw new Error('Excel dataset must be an array.');

  const datasetDirectory = await realpath(excelDatasetDirectory);
  return await Promise.all(
    raw.map(async (value, index) => {
      const record = parseExcelGoldenCaseRecord(value, index);
      const workbookPath = await resolveWorkbookPath(record.workbook, datasetDirectory, index);

      return {
        id: record.id,
        name: record.name,
        ...(record.description === undefined ? {} : { description: record.description }),
        input: {
          message: record.input,
          excelResource: { id: excelResourceId, filePath: workbookPath },
        },
        expected: record.expected,
        tags: record.tags,
      } satisfies ExcelGoldenCase;
    }),
  );
}

/** Validates the required raw fields before they enter the generic EvalCase contract. */
function parseExcelGoldenCaseRecord(value: unknown, index: number): ExcelGoldenCaseRecord {
  if (!isRecord(value)) throw new Error(`Excel dataset case ${index} must be an object.`);

  const id = requireNonEmptyString(value.id, `Excel dataset case ${index} id`);
  const name = requireNonEmptyString(value.name, `Excel dataset case ${index} name`);
  const input = requireNonEmptyString(value.input, `Excel dataset case ${index} input`);
  const workbook = requireNonEmptyString(value.workbook, `Excel dataset case ${index} workbook`);
  const expected = parseExpected(value.expected, index);
  if (!Array.isArray(value.tags) || !value.tags.every((tag) => isNonEmptyString(tag))) {
    throw new Error(`Excel dataset case ${index} tags must be non-empty strings.`);
  }

  return {
    id,
    name,
    ...(value.description === undefined
      ? {}
      : {
          description: requireNonEmptyString(
            value.description,
            `Excel dataset case ${index} description`,
          ),
        }),
    input,
    workbook,
    expected,
    tags: value.tags,
  };
}

/** Validates the deliberately small Excel expected-value contract. */
function parseExpected(value: unknown, index: number): ExcelGoldenCaseExpected {
  if (!isRecord(value)) {
    throw new Error(
      `Excel dataset case ${index} expected must define sheetCount, sheetRows, topRegionSales, or workbookMutation.`,
    );
  }

  const behavior = parseBehaviorExpected(value.behavior, index);

  if (value.topRegionSales !== undefined) {
    return { topRegionSales: parseTopRegionSalesExpected(value.topRegionSales, index), ...behavior };
  }

  if (value.sheetRows !== undefined) {
    if (!Array.isArray(value.sheetRows) || value.sheetRows.length === 0) {
      throw new Error(`Excel dataset case ${index} expected.sheetRows must be a non-empty array.`);
    }

    const sheetRows = value.sheetRows.map((sheet, sheetIndex) => {
      if (!isRecord(sheet)) {
        throw new Error(
          `Excel dataset case ${index} expected.sheetRows[${sheetIndex}] must be an object.`,
        );
      }
      const sheetName = sheet.sheetName;
      if (!isNonEmptyString(sheetName)) {
        throw new Error(
          `Excel dataset case ${index} expected.sheetRows[${sheetIndex}].sheetName must be a non-empty string.`,
        );
      }
      if (!isNonNegativeInteger(sheet.dataRowCount)) {
        throw new Error(
          `Excel dataset case ${index} expected.sheetRows[${sheetIndex}].dataRowCount must be an integer >= 0.`,
        );
      }
      if (!isNonNegativeInteger(sheet.headerRowCount)) {
        throw new Error(
          `Excel dataset case ${index} expected.sheetRows[${sheetIndex}].headerRowCount must be an integer >= 0.`,
        );
      }
      return {
        sheetName,
        dataRowCount: sheet.dataRowCount,
        headerRowCount: sheet.headerRowCount,
      } satisfies ExcelGoldenSheetRowsExpected;
    });

    return { sheetRows, ...behavior };
  }

  if (value.workbookMutation !== undefined) {
    return {
      workbookMutation: parseWorkbookMutationExpected(value.workbookMutation, index),
      ...behavior,
    };
  }

  if (!isNonNegativeInteger(value.sheetCount)) {
    throw new Error(`Excel dataset case ${index} expected.sheetCount must be an integer >= 0.`);
  }
  return { sheetCount: value.sheetCount, ...behavior };
}

/** Validates the minimal Trace behavior contract at the dataset boundary. */
function parseBehaviorExpected(
  value: unknown,
  index: number,
): { readonly behavior?: TraceBehaviorExpected } {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    throw new Error(`Excel dataset case ${index} expected.behavior must be an object.`);
  }

  const requiredTools = parseToolNames(value.requiredTools, 'requiredTools', index);
  const forbiddenTools = parseToolNames(value.forbiddenTools, 'forbiddenTools', index);
  const maxToolErrors = value.maxToolErrors;
  if (maxToolErrors !== undefined && !isNonNegativeInteger(maxToolErrors)) {
    throw new Error(
      `Excel dataset case ${index} expected.behavior.maxToolErrors must be an integer >= 0.`,
    );
  }

  const forbiddenToolSet = new Set(forbiddenTools ?? []);
  const conflictingTool = (requiredTools ?? []).find((tool) => forbiddenToolSet.has(tool));
  if (conflictingTool !== undefined) {
    throw new Error(
      `Excel dataset case ${index} expected.behavior tool ${conflictingTool} cannot be both required and forbidden.`,
    );
  }

  return {
    behavior: {
      ...(requiredTools === undefined ? {} : { requiredTools }),
      ...(forbiddenTools === undefined ? {} : { forbiddenTools }),
      ...(maxToolErrors === undefined ? {} : { maxToolErrors }),
    },
  };
}

/** Validates an optional unique list of non-empty tool names. */
function parseToolNames(
  value: unknown,
  field: string,
  index: number,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((tool) => isNonEmptyString(tool))) {
    throw new Error(`Excel dataset case ${index} expected.behavior.${field} must be an array of non-empty strings.`);
  }
  if (new Set(value).size !== value.length) {
    throw new Error(`Excel dataset case ${index} expected.behavior.${field} must not contain duplicates.`);
  }
  return value;
}

/** Validates the fixed worksheet, region, sales, and order-count Golden values. */
function parseTopRegionSalesExpected(
  value: unknown,
  index: number,
): ExcelGoldenTopRegionSalesExpected {
  if (!isRecord(value)) {
    throw new Error(`Excel dataset case ${index} expected.topRegionSales must be an object.`);
  }
  const sheetName = value.sheetName;
  if (!isNonEmptyString(sheetName)) {
    throw new Error(
      `Excel dataset case ${index} expected.topRegionSales.sheetName must be a non-empty string.`,
    );
  }
  const region = value.region;
  if (!isNonEmptyString(region)) {
    throw new Error(
      `Excel dataset case ${index} expected.topRegionSales.region must be a non-empty string.`,
    );
  }
  const totalSales = value.totalSales;
  if (!isFiniteNumber(totalSales)) {
    throw new Error(
      `Excel dataset case ${index} expected.topRegionSales.totalSales must be a finite number.`,
    );
  }
  const orderCount = value.orderCount;
  if (!isNonNegativeInteger(orderCount)) {
    throw new Error(
      `Excel dataset case ${index} expected.topRegionSales.orderCount must be an integer >= 0.`,
    );
  }
  return { sheetName, region, totalSales, orderCount };
}

/** Validates the worksheet range and matrix used by a workbook mutation Golden Case. */
function parseWorkbookMutationExpected(
  value: unknown,
  index: number,
): ExcelGoldenWorkbookMutationExpected {
  if (!isRecord(value)) {
    throw new Error(`Excel dataset case ${index} expected.workbookMutation must be an object.`);
  }

  const sheetName = value.sheetName;
  if (!isNonEmptyString(sheetName)) {
    throw new Error(
      `Excel dataset case ${index} expected.workbookMutation.sheetName must be a non-empty string.`,
    );
  }

  const range = value.range;
  if (!isNonEmptyString(range)) {
    throw new Error(
      `Excel dataset case ${index} expected.workbookMutation.range must be a non-empty string.`,
    );
  }

  const rawExpectedValues = value.expectedValues;
  if (
    !Array.isArray(rawExpectedValues) ||
    rawExpectedValues.length === 0 ||
    !rawExpectedValues.every((row) => Array.isArray(row))
  ) {
    throw new Error(
      `Excel dataset case ${index} expected.workbookMutation.expectedValues must be a non-empty two-dimensional array.`,
    );
  }

  return {
    sheetName,
    range,
    expectedValues: rawExpectedValues.map((row) => [...row]),
  };
}

/** Resolves one workbook only when it remains inside the checked-in Excel dataset directory. */
async function resolveWorkbookPath(
  workbook: string,
  datasetDirectory: string,
  index: number,
): Promise<string> {
  if (isAbsolute(workbook)) {
    throw new Error(`Excel dataset case ${index} workbook must be relative to the Excel dataset.`);
  }

  const candidatePath = resolve(datasetDirectory, workbook);
  if (!isPathInside(datasetDirectory, candidatePath)) {
    throw new Error(`Excel dataset case ${index} workbook escapes the Excel dataset directory.`);
  }

  let resolvedPath: string;
  try {
    resolvedPath = await realpath(candidatePath);
  } catch (error: unknown) {
    throw new Error(`Excel dataset case ${index} workbook fixture does not exist: ${workbook}.`, {
      cause: error,
    });
  }
  if (!isPathInside(datasetDirectory, resolvedPath)) {
    throw new Error(`Excel dataset case ${index} workbook escapes the Excel dataset directory.`);
  }

  const workbookStats = await stat(resolvedPath);
  if (!workbookStats.isFile()) {
    throw new Error(`Excel dataset case ${index} workbook fixture is not a file: ${workbook}.`);
  }
  return resolvedPath;
}

/** Keeps both traversal paths and symlink-resolved paths inside the dataset directory. */
function isPathInside(directory: string, candidate: string): boolean {
  const pathFromDirectory = relative(directory, candidate);
  return (
    pathFromDirectory.length > 0 &&
    pathFromDirectory !== '..' &&
    !pathFromDirectory.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromDirectory)
  );
}

/** Validates a required non-blank dataset string. */
function requireNonEmptyString(value: unknown, field: string): string {
  if (!isNonEmptyString(value)) throw new Error(`${field} must be a non-empty string.`);
  return value;
}

/** Checks a dataset value without widening it to an unsafe type. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Checks user-authored dataset labels and prompts. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Checks the fixed numeric shape used by Excel Golden expected values. */
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** Checks a numeric expected value without accepting NaN or infinities. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
