import { describe, expect, it } from 'vitest';

import { createExcelToolPresentationResolver } from '../src/index.js';

describe('Excel tool presentation resolver', () => {
  const resolve = createExcelToolPresentationResolver();

  it('provides safe display metadata for the current workbook tools', () => {
    expect(resolve({ name: 'get_workbook_info', arguments: {} })).toEqual({
      title: 'Read Workbook',
    });
    expect(resolve({ name: 'get_sheet_profile', arguments: { sheetName: 'Sheet1' } })).toEqual({
      title: 'Inspect Worksheet',
      subject: 'Sheet1',
    });
    expect(
      resolve({
        name: 'aggregate_data',
        arguments: {
          sheetName: 'Sales',
          groupBy: ['Region'],
          metrics: [{ column: 'Sales', operation: 'sum' }],
        },
      }),
    ).toEqual({
      title: 'Aggregate Excel data',
      subject: 'Sales',
      detail: 'Group by Region · Metrics: sum',
    });
    expect(
      resolve({ name: 'filter_data', arguments: { sheetName: 'Sales', conditions: [{}, {}] } }),
    ).toEqual({
      title: 'Filter Excel data',
      subject: 'Sales',
      detail: 'Conditions: 2',
    });
    expect(
      resolve({ name: 'write_data', arguments: { sheetName: 'Sheet1', startCell: 'B2' } }),
    ).toEqual({
      title: 'Write Excel data',
      subject: 'Sheet1',
      detail: 'Starting at B2',
    });
  });

  it('does not expose internal file paths and leaves unknown tools unresolved', () => {
    expect(
      resolve({
        name: 'get_sheet_profile',
        arguments: { sheetName: 'Sheet1', filePath: 'C:/secret.xlsx' },
      }),
    ).toEqual({
      title: 'Inspect Worksheet',
      subject: 'Sheet1',
    });
    expect(
      resolve({
        name: 'write_data',
        arguments: { sheetName: 'Sheet1', startCell: 'B2', filePath: 'C:/secret.xlsx' },
      }),
    ).toEqual({
      title: 'Write Excel data',
      subject: 'Sheet1',
      detail: 'Starting at B2',
    });
    expect(resolve({ name: 'unknown_tool', arguments: {} })).toBeUndefined();
  });
});
