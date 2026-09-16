import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { EvalCase } from '../core/eval-case.js';
import type { AgentEvalInput } from '../executors/agent-eval-executor.js';

/** Fixed, checked-in expected facts for one Excel Golden Case. */
export interface ExcelGoldenCaseExpected {
  readonly sheetCount?: number;
  readonly sheetRows?: readonly ExcelGoldenSheetRowsExpected[];
  readonly topRegionSales?: ExcelGoldenTopRegionSalesExpected;
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
      `Excel dataset case ${index} expected must define sheetCount, sheetRows, or topRegionSales.`,
    );
  }

  if (value.topRegionSales !== undefined) {
    return { topRegionSales: parseTopRegionSalesExpected(value.topRegionSales, index) };
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

    return { sheetRows };
  }

  if (!isNonNegativeInteger(value.sheetCount)) {
    throw new Error(`Excel dataset case ${index} expected.sheetCount must be an integer >= 0.`);
  }
  return { sheetCount: value.sheetCount };
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
