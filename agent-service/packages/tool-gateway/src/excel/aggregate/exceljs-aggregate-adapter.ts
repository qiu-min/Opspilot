import type { Worksheet } from 'exceljs';

import { formatCellAddress } from '../shared/cell-reference.js';
import { resolveDatasetContext, type ExcelDatasetContext } from '../shared/exceljs/dataset-context.js';
import { ExcelCapabilityError, ExcelCapabilityErrorCode } from '../shared/errors.js';
import {
  executeExcelOperation,
  openWorkbook,
  requireWorksheet,
  throwIfAborted,
} from '../shared/exceljs/workbook-io.js';
import { parseExcelCellValue } from '../shared/exceljs/cell-value.js';
import { resolveHeaderColumn, type ExcelHeaderColumn } from '../shared/exceljs/header.js';
import { hasActualValueInRow } from '../shared/exceljs/used-range.js';
import {
  evaluatePredicates,
  type ResolvedExcelPredicate,
} from '../shared/query/predicate-engine.js';
import type {
  AggregateDataInput,
  AggregateDataResult,
  AggregateMetric,
  AggregateOperation,
  AggregateResultColumn,
  AggregateWhere,
} from './contracts.js';
import {
  createGroupAccumulator,
  createTypedGroupKey,
  createValueContext,
  finalizeMetricAccumulator,
  toGroupValue,
  updateMetricAccumulator,
  type GroupAccumulator,
  type SourceCellValue,
} from './aggregation-engine.js';
import type { ExcelAggregateConnector } from './connector.js';
import { aggregateDataInputSchema } from './schemas.js';

export class ExcelJsAggregateAdapter implements ExcelAggregateConnector {
  /** Aggregates worksheet rows by selected columns and metrics. */
  async aggregateData(
    input: AggregateDataInput,
    signal?: AbortSignal,
  ): Promise<AggregateDataResult> {
    const validated = aggregateDataInputSchema.parse(input);

    return executeExcelOperation('aggregateData', validated.filePath, signal, async () => {
      const workbook = await openWorkbook(validated.filePath, signal);
      const worksheet = requireWorksheet(workbook, validated.sheetName);
      const dataset = resolveDatasetContext(
        worksheet,
        validated.range,
        signal,
        'aggregateData',
      );
      const plan = createAggregationPlan(dataset, validated);
      const groups = new Map<string, GroupAccumulator>();

      if (plan.groupBy.length === 0) {
        groups.set(createTypedGroupKey([]), createGroupAccumulator([], plan.metrics.length));
      }

      let sourceRowCount = 0;
      if (dataset.range !== undefined && dataset.dataStartRow !== null) {
        for (let row = dataset.dataStartRow; row <= dataset.range.end.row; row += 1) {
          throwIfAborted(signal, 'aggregateData');
          if (
            !hasActualValueInRow(
              worksheet,
              row,
              dataset.range.start.column,
              dataset.range.end.column,
            )
          ) {
            continue;
          }
          sourceRowCount += 1;

          const rowValues = readSelectedValues(worksheet, row, plan.sourceColumns);
          if (
            plan.where !== undefined &&
            !evaluatePredicates(
              rowValues,
              plan.where.conditions,
              plan.where.logic,
              (predicate) => ({
                sheetName: validated.sheetName,
                column: predicate.predicate.column,
                address: formatCellAddress({ row, column: predicate.columnIndex }),
                operator: predicate.predicate.operator,
              }),
            )
          ) {
            continue;
          }

          const groupValues = plan.groupBy.map((column) =>
            toGroupValue(
              rowValues.get(column.columnIndex),
              createValueContext(
                validated.sheetName,
                column.name,
                row,
                column.columnIndex,
                'groupBy',
              ),
            ),
          );
          const groupKey = createTypedGroupKey(groupValues);
          const group =
            groups.get(groupKey) ?? createGroupAccumulator(groupValues, plan.metrics.length);
          groups.set(groupKey, group);

          for (let index = 0; index < plan.metrics.length; index += 1) {
            const metric = plan.metrics[index];
            if (metric === undefined) {
              continue;
            }

            updateMetricAccumulator(
              group.metrics[index],
              metric.operation,
              rowValues.get(metric.column.columnIndex),
              createValueContext(
                validated.sheetName,
                metric.column.name,
                row,
                metric.column.columnIndex,
                metric.operation,
              ),
            );
          }
        }
      }

      const rows = [...groups.values()].map((group) => [
        ...group.groupValues,
        ...group.metrics.map((metric, index) =>
          finalizeMetricAccumulator(metric, plan.metrics[index]?.operation),
        ),
      ]);

      return {
        sheetName: worksheet.name,
        columns: plan.resultColumns,
        rows,
        sourceRowCount,
        resultRowCount: rows.length,
      };
    });
  }
}

type ResolvedColumn = ExcelHeaderColumn;

interface ResolvedMetric {
  readonly column: ResolvedColumn;
  readonly operation: AggregateOperation;
}

interface AggregationPlan {
  readonly groupBy: readonly ResolvedColumn[];
  readonly metrics: readonly ResolvedMetric[];
  readonly where: ResolvedWhere | undefined;
  readonly sourceColumns: readonly ResolvedColumn[];
  readonly resultColumns: readonly AggregateResultColumn[];
}

interface ResolvedWhere {
  readonly conditions: readonly ResolvedExcelPredicate[];
  readonly logic: 'all' | 'any';
}

/** Resolves all requested columns and builds the single-pass aggregation plan. */
function createAggregationPlan(
  dataset: ExcelDatasetContext,
  input: {
    readonly sheetName: string;
    readonly where?: AggregateWhere;
    readonly groupBy: readonly string[];
    readonly metrics: readonly AggregateMetric[];
  },
): AggregationPlan {
  const header = dataset.header;
  const groupBy = input.groupBy.map((column) =>
    resolveHeaderColumn(column, header, input.sheetName),
  );
  const metrics = input.metrics.map((metric) => ({
    column: resolveHeaderColumn(metric.column, header, input.sheetName),
    operation: metric.operation,
  }));
  const where =
    input.where === undefined
      ? undefined
      : {
          conditions: input.where.conditions.map((predicate) => ({
            predicate,
            columnIndex: resolveHeaderColumn(predicate.column, header, input.sheetName).columnIndex,
          })),
          logic: input.where.logic ?? 'all',
        };
  const resultColumns = createResultColumns(groupBy, input.metrics);
  const sourceColumns = uniqueColumns([
    ...groupBy,
    ...metrics.map((metric) => metric.column),
    ...(where?.conditions.map((predicate) => ({
      name: predicate.predicate.column,
      columnIndex: predicate.columnIndex,
    })) ?? []),
  ]);

  return {
    groupBy,
    metrics,
    where,
    sourceColumns,
    resultColumns,
  };
}

/** Builds and validates the group and metric output columns. */
function createResultColumns(
  groupBy: readonly ResolvedColumn[],
  metrics: readonly AggregateMetric[],
): readonly AggregateResultColumn[] {
  const columns: AggregateResultColumn[] = groupBy.map((column) => ({
    name: column.name,
    kind: 'group',
    sourceColumn: column.name,
  }));

  for (const metric of metrics) {
    const name = metric.alias ?? `${metric.column}.${metric.operation}`;
    columns.push({
      name,
      kind: 'metric',
      sourceColumn: metric.column,
      operation: metric.operation,
    });
  }

  const seen = new Set<string>();
  for (const column of columns) {
    if (seen.has(column.name)) {
      throw new ExcelCapabilityError(
        ExcelCapabilityErrorCode.DUPLICATE_OUTPUT_COLUMN,
        `Aggregate output column '${column.name}' is duplicated`,
        { name: column.name },
      );
    }
    seen.add(column.name);
  }

  return columns;
}

/** Removes duplicate source columns so each selected cell is read once per row. */
function uniqueColumns(columns: readonly ResolvedColumn[]): readonly ResolvedColumn[] {
  const seen = new Set<number>();
  const unique: ResolvedColumn[] = [];
  for (const column of columns) {
    if (seen.has(column.columnIndex)) {
      continue;
    }
    seen.add(column.columnIndex);
    unique.push(column);
  }
  return unique;
}

/** Reads each required source column once for one data row. */
function readSelectedValues(
  worksheet: Worksheet,
  row: number,
  columns: readonly ResolvedColumn[],
): ReadonlyMap<number, SourceCellValue> {
  const values = new Map<number, SourceCellValue>();
  for (const column of columns) {
    values.set(
      column.columnIndex,
      parseExcelCellValue(worksheet.findCell(row, column.columnIndex)?.value),
    );
  }
  return values;
}
