import type { Cell, Worksheet } from 'exceljs';

import type { CellRange } from '../cell-reference.js';

export type UsedRangeMode = 'values' | 'valuesAndMetadata';

export function findUsedRange(
  worksheet: Worksheet,
  mode: UsedRangeMode = 'valuesAndMetadata',
): CellRange | undefined {
  let top = Number.POSITIVE_INFINITY;
  let left = Number.POSITIVE_INFINITY;
  let bottom = 0;
  let right = 0;

  const updateBounds = (cell: Cell): void => {
    if (!hasCellContent(cell, mode)) {
      return;
    }

    top = Math.min(top, cell.fullAddress.row);
    left = Math.min(left, cell.fullAddress.col);
    bottom = Math.max(bottom, cell.fullAddress.row);
    right = Math.max(right, cell.fullAddress.col);
  };

  if (mode === 'values') {
    worksheet.eachRow((row) => {
      row.eachCell((cell) => updateBounds(cell));
    });
  } else {
    worksheet.eachRow({ includeEmpty: true }, (row) => {
      row.eachCell({ includeEmpty: true }, (cell) => updateBounds(cell));
    });
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
