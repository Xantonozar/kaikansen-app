import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { compactRelativeTime, relativeTime } from './time';

/**
 * Relative-time ladders (src/time.ts): just now / minutes /
 * hours / days, then the plain date; invalid input reads as ''.
 * Date.now is pinned so the boundaries are deterministic.
 */

const NOW = Date.parse('2026-11-10T12:00:00.000Z');
const secondsAgo = (s: number) => new Date(NOW - s * 1000).toISOString();

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('relativeTime', () => {
  it('climbs the ladder at the exact boundaries', () => {
    expect(relativeTime(secondsAgo(30))).toBe('just now');
    expect(relativeTime(secondsAgo(59))).toBe('just now');
    expect(relativeTime(secondsAgo(60))).toBe('1m ago');
    expect(relativeTime(secondsAgo(59 * 60))).toBe('59m ago');
    expect(relativeTime(secondsAgo(60 * 60))).toBe('1h ago');
    expect(relativeTime(secondsAgo(23 * 3600))).toBe('23h ago');
    expect(relativeTime(secondsAgo(24 * 3600))).toBe('1d ago');
    expect(relativeTime(secondsAgo(6 * 86400))).toBe('6d ago');
  });

  it('falls back to the plain date at a week', () => {
    const iso = secondsAgo(7 * 86400);
    expect(relativeTime(iso)).toBe(new Date(iso).toLocaleDateString());
  });

  it('answers empty for an unparseable timestamp', () => {
    expect(relativeTime('not-a-date')).toBe('');
    expect(relativeTime('')).toBe('');
  });
});

describe('compactRelativeTime', () => {
  it('drops the "ago" but keeps the ladder', () => {
    expect(compactRelativeTime(secondsAgo(10))).toBe('just now');
    expect(compactRelativeTime(secondsAgo(5 * 60))).toBe('5m');
    expect(compactRelativeTime(secondsAgo(2 * 3600))).toBe('2h');
    expect(compactRelativeTime(secondsAgo(2 * 86400))).toBe('2d');
    const iso = secondsAgo(30 * 86400);
    expect(compactRelativeTime(iso)).toBe(
      new Date(iso).toLocaleDateString(),
    );
  });

  it('answers empty for an unparseable timestamp', () => {
    expect(compactRelativeTime('nope')).toBe('');
  });
});
