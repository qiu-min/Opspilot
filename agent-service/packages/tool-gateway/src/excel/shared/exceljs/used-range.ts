import type { Cell, Worksheet } from 'exceljs';

import { parseCellRange, type CellRange } from '../cell-reference.js';

export type UsedRangeMode = 'values' | 'valuesAndMetadata';

export function findUsedRange(
  worksheet: Worksheet,
  mode: UsedRangeMode = 'valuesAndMetadata',
): CellRange | undefined {
  let top = Number.POSITIVE_INFINITY;
  let left = Number.POSITIVE_INFINITY;
  let bottom = 0;
  let right = 0;

  const updateRangeBounds = (range: CellRange): void => {
    top = Math.min(top, range.start.row);
    left = Math.min(left, range.start.column);
    bottom = Math.max(bottom, range.end.row);
    right = Math.max(right, range.end.column);
  };

  const updateBounds = (cell: Cell): void => {
    if (!hasCellContent(cell, mode)) {
      return;
    }

    updateRangeBounds({
      start: { row: cell.fullAddress.row, column: cell.fullAddress.col },
      end: { row: cell.fullAddress.row, column: cell.fullAddress.col },
    });
  };

  if (mode === 'values') {
    worksheet.eachRow((row) => {
      row.eachCell((cell) => updateBounds(cell));
    });
  } else {
    worksheet.eachRow({ includeEmpty: true }, (row) => {
      row.eachCell({ includeEmpty: true }, (cell) => updateBounds(cell));
    });
    updateValidationBounds(worksheet, updateRangeBounds);
  }

  if (bottom === 0 || right === 0) {
    return undefined;
  }

  return {
    start: { row: top, column: left },
    end: { row: bottom, column: right },
  };
}

export function hasActualCellValue(cell: Cell): boolean {
  return cell.value !== null && cell.value !== undefined;
}

function hasCellContent(cell: Cell, mode: UsedRangeMode): boolean {
  return (
    hasActualCellValue(cell) || (mode === 'valuesAndMetadata' && cell.dataValidation !== undefined)
  );
}

interface WorksheetWithDataValidations extends Worksheet {
  readonly dataValidations?: {
    readonly model?: Readonly<Record<string, unknown>>;
  };
}

function updateValidationBounds(
  worksheet: Worksheet,
  updateRangeBounds: (range: CellRange) => void,
): void {
  const dataValidations = (worksheet as WorksheetWithDataValidations).dataValidations;
  const model = dataValidations?.model;
  if (!model) {
    return;
  }

  for (const address of Object.keys(model)) {
    if (model[address] === undefined) {
      continue;
    }

    for (const rangeReference of address.split(/\s+/)) {
      if (rangeReference.length > 0) {
        updateRangeBounds(parseCellRange(rangeReference));
      }
    }
  }
}
