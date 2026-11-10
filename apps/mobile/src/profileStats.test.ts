import { describe, expect, it } from '@jest/globals';
import type { ProfileStats } from '@kaikansen/contracts';
import {
  formatCount,
  formatHoursListened,
  formatMeanRating,
  formatThemesListened,
} from './profileStats';

/**
 * Profile-stat formatting (src/profileStats.ts) — the language
 * both profile surfaces speak: grouped counts, 1-decimal mean
 * with the "—" null state, and the two-regime hours format.
 */

function stats(overrides: Partial<ProfileStats> = {}): ProfileStats {
  return {
    meanRating: null,
    themesListened: 0,
    totalListenedSeconds: 0,
    followersCount: 0,
    followingCount: 0,
    ...overrides,
  };
}

describe('formatCount', () => {
  it('groups thousands en-US style', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(999)).toBe('999');
    expect(formatCount(1234)).toBe('1,234');
    expect(formatCount(1000000)).toBe('1,000,000');
  });
});

describe('formatMeanRating', () => {
  it('renders one decimal, and the dash for the null state', () => {
    expect(formatMeanRating(stats({ meanRating: 8.5 }))).toBe('8.5');
    expect(formatMeanRating(stats({ meanRating: 10 }))).toBe('10.0');
    expect(formatMeanRating(stats({ meanRating: null }))).toBe('—');
  });
});

describe('formatThemesListened', () => {
  it('is the grouped count', () => {
    expect(formatThemesListened(stats({ themesListened: 132 }))).toBe('132');
    expect(formatThemesListened(stats({ themesListened: 2048 }))).toBe(
      '2,048',
    );
  });
});

describe('formatHoursListened', () => {
  it('shows one decimal under 100 hours', () => {
    expect(formatHoursListened(stats({ totalListenedSeconds: 0 }))).toBe('0');
    expect(formatHoursListened(stats({ totalListenedSeconds: 3600 }))).toBe(
      '1',
    );
    expect(
      formatHoursListened(stats({ totalListenedSeconds: 73.5 * 3600 })),
    ).toBe('73.5');
    expect(
      formatHoursListened(stats({ totalListenedSeconds: 99.94 * 3600 })),
    ).toBe('99.9');
  });

  it('rounds and groups at/above 100 hours', () => {
    expect(
      formatHoursListened(stats({ totalListenedSeconds: 100 * 3600 })),
    ).toBe('100');
    expect(
      formatHoursListened(stats({ totalListenedSeconds: 1205 * 3600 })),
    ).toBe('1,205');
  });
});
