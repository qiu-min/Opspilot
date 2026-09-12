import { describe, expect, it } from 'vitest';

import { createExcelToolPresentationResolver } from '../src/index.js';

describe('Excel tool presentation resolver', () => {
  const resolve = createExcelToolPresentationResolver();

  it('provides safe display metadata for the current workbook tools', () => {
    expect(resolve({ name: 'get_workbook_info', arguments: {} })).toEqual({ title: 'Read Workbook' });
    expect(resolve({ name: 'get_sheet_profile', arguments: { sheetName: 'Sheet1' } })).toEqual({
      title: 'Inspect Worksheet',
      subject: 'Sheet1',
    });
  });

  it('does not expose internal file paths and leaves unknown tools unresolved', () => {
    expect(resolve({ name: 'get_sheet_profile', arguments: { sheetName: 'Sheet1', filePath: 'C:/secret.xlsx' } })).toEqual({
      title: 'Inspect Worksheet',
      subject: 'Sheet1',
    });
    expect(resolve({ name: 'unknown_tool', arguments: {} })).toBeUndefined();
  });
});
