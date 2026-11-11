import { describe, expect, it } from '@jest/globals';
import { downloadFillPercent, sectionStatus } from './polishRules';

describe('downloadFillPercent — downloads indeterminate honesty', () => {
  it('renders no fill while the fraction is unknown', () => {
    expect(downloadFillPercent(null)).toBeNull();
    expect(downloadFillPercent(undefined)).toBeNull();
    expect(downloadFillPercent(Number.NaN)).toBeNull();
  });

  it('maps a real fraction to its clamped percentage', () => {
    expect(downloadFillPercent(0)).toBe(0);
    expect(downloadFillPercent(0.42)).toBe(42);
    expect(downloadFillPercent(1)).toBe(100);
    expect(downloadFillPercent(1.4)).toBe(100);
    expect(downloadFillPercent(-0.2)).toBe(0);
  });
});

describe('sectionStatus — profile satellite failure derivation', () => {
  it('is loading until the fetch settles', () => {
    expect(sectionStatus(false, false)).toBe('loading');
  });

  it('is failed only for a settled failure with no data', () => {
    expect(sectionStatus(true, false)).toBe('failed');
  });

  it('data wins over a stale failure flag (cache swap recovery)', () => {
    expect(sectionStatus(true, true)).toBe('ready');
    expect(sectionStatus(false, true)).toBe('ready');
  });
});
