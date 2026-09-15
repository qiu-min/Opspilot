import { describe, expect, it } from 'vitest';

import { measureExcelRange } from '../src/index.js';

describe('measureExcelRange', () => {
  it.each([
    ['A1', { rowCount: 1, columnCount: 1, cellCount: 1 }],
    ['a01', { rowCount: 1, columnCount: 1, cellCount: 1 }],
    ['A1:B2', { rowCount: 2, columnCount: 2, cellCount: 4 }],
    ['Z1:AA10', { rowCount: 10, columnCount: 2, cellCount: 20 }],
    ['AA20:AD30', { rowCount: 11, columnCount: 4, cellCount: 44 }],
  ])('measures %s', (range, shape) => {
    expect(measureExcelRange(range)).toEqual(shape);
  });

  it.each([
    'A',
    '1',
    'A0',
    'A1:',
    ':A1',
    'B10:A1',
    'B2:A1',
    'A1:A0',
    'A1:B',
    'A1:B0',
    'A:A',
    '1:10',
    'Sheet1!A1:B2',
    'NamedRange',
  ])('rejects unsupported reference %s', (range) => {
    expect(() => measureExcelRange(range)).toThrow();
  });

  it('rejects unsafe rows, columns, and cell-count multiplication', () => {
    expect(measureExcelRange('A1:A9007199254740991').cellCount).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => measureExcelRange('A1:B9007199254740991')).toThrow(/safe integer/);
    expect(() => measureExcelRange('A1:B9007199254740992')).toThrow(/safe integer/);
    expect(() => measureExcelRange('A1:ZZZZZZZZZZZZZ2')).toThrow(/safe integer/);
  });
});
