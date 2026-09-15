/** Dimensions of a validated explicit A1-style Excel range. */
export interface ExcelRangeShape {
  readonly rowCount: number;
  readonly columnCount: number;
  readonly cellCount: number;
}

/** Measures one explicit A1 cell or rectangular range using safe integer arithmetic. */
export function measureExcelRange(range: string): ExcelRangeShape {
  const match = /^([A-Za-z]+)(\d+)(?::([A-Za-z]+)(\d+))?$/.exec(range);
  if (match === null) {
    throw new TypeError('read_range range must be an explicit A1 cell or rectangular range.');
  }

  const startColumn = parseColumnNumber(match[1]!);
  const startRow = parseRowNumber(match[2]!);
  const endColumn = match[3] === undefined ? startColumn : parseColumnNumber(match[3]);
  const endRow = match[4] === undefined ? startRow : parseRowNumber(match[4]);

  if (startColumn > endColumn || startRow > endRow) {
    throw new TypeError('read_range range start must not be after its end.');
  }

  const rowCount = endRow - startRow + 1;
  const columnCount = endColumn - startColumn + 1;
  if (!Number.isSafeInteger(rowCount) || !Number.isSafeInteger(columnCount)) {
    throw new RangeError('read_range range dimensions exceed JavaScript safe integer limits.');
  }

  const cellCount = multiplySafeIntegers(rowCount, columnCount);
  return { rowCount, columnCount, cellCount };
}

/** Parses a positive A1 row number without accepting unsafe integer values. */
function parseRowNumber(value: string): number {
  const row = Number(value);
  if (!Number.isSafeInteger(row) || row < 1) {
    throw new RangeError('read_range range row exceeds JavaScript safe integer limits.');
  }
  return row;
}

/** Parses column letters into a positive safe one-based column number. */
function parseColumnNumber(value: string): number {
  let column = 0;
  for (const character of value.toUpperCase()) {
    column = column * 26 + character.charCodeAt(0) - 64;
    if (!Number.isSafeInteger(column)) {
      throw new RangeError('read_range range column exceeds JavaScript safe integer limits.');
    }
  }
  return column;
}

/** Multiplies positive safe integers exactly and only returns a safe Number. */
function multiplySafeIntegers(left: number, right: number): number {
  if (!Number.isSafeInteger(left) || left < 1 || !Number.isSafeInteger(right) || right < 1) {
    throw new RangeError('read_range range cell count exceeds JavaScript safe integer limits.');
  }
  const cellCount = BigInt(left) * BigInt(right);
  if (cellCount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('read_range range cell count exceeds JavaScript safe integer limits.');
  }
  return Number(cellCount);
}
