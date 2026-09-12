import { describe, expect, it } from 'vitest';

import { resolveToolPresentation, type ToolPresentationResolver } from '../src/index.js';

describe('resolveToolPresentation', () => {
  const options = {
    name: 'lookup',
    arguments: { sheetName: 'Sheet1' },
  };

  it('returns the resolver display and keeps only UI-safe fields', () => {
    const resolver: ToolPresentationResolver = () =>
      ({
        title: 'Inspect Worksheet',
        subject: 'Sheet1',
        detail: 'Reading cells',
        rawArgs: { sheetName: 'Sheet1' },
      }) as unknown as ReturnType<ToolPresentationResolver>;

    expect(resolveToolPresentation({ ...options, resolver })).toEqual({
      title: 'Inspect Worksheet',
      subject: 'Sheet1',
      detail: 'Reading cells',
    });
  });

  it('falls back when the resolver returns undefined', () => {
    expect(resolveToolPresentation({ ...options, resolver: () => undefined })).toEqual({
      title: 'lookup',
    });
  });

  it('falls back when the resolver throws', () => {
    expect(
      resolveToolPresentation({
        ...options,
        resolver: () => {
          throw new Error('resolver failed');
        },
      }),
    ).toEqual({ title: 'lookup' });
  });

  it.each([
    { title: 123, subject: 'Sheet1', detail: 'Reading cells' },
    { title: 'Inspect Worksheet', subject: 123, detail: 'Reading cells' },
    { title: 'Inspect Worksheet', subject: 'Sheet1', detail: 123 },
  ])('falls back when the resolver returns an invalid display', (display) => {
    expect(
      resolveToolPresentation({
        ...options,
        resolver: () => display as unknown as ReturnType<ToolPresentationResolver>,
      }),
    ).toEqual({ title: 'lookup' });
  });
});
