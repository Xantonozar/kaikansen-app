import { describe, expect, it } from '@jest/globals';
import {
  LADDER,
  formatRp,
  ladderForRp,
  ladderInfo,
  ladderLabel,
  standingOf,
} from './rankUtil';

/**
 * The 24-rank ladder table + derivation (src/rankUtil.ts) — the
 * mirror of the API's ladderForRp suite: same thresholds, same
 * progress-target rule (the rank AFTER next, per the approved
 * designs' worked example).
 */

describe('LADDER table', () => {
  it('carries the locked 24 ranks in order with their thresholds', () => {
    expect(LADDER).toHaveLength(24);
    expect(LADDER.map((r) => r.rank)).toEqual([
      'academy-student', 'scout', 'mizunoto', 'genin', 'chunin',
      'shinobi', 'assassin', 'firebender', 'kitsune', 'lone-wolf',
      'karasu', 'jonin', 'ronin', 'shogun', 'anbu', 'pilot', 'sannin',
      'berserk', 'wizard-king', 'jinchuriki', 'newtype', 'overlord',
      'shadow-monarch', 'pirate-king',
    ]);
    expect(LADDER.map((r) => r.min)).toEqual([
      0, 100, 250, 450, 700, 1000, 1400, 1900, 2500, 3200, 4000, 4900,
      5900, 7000, 8200, 9500, 14000, 15700, 19400, 21400, 23500, 25700,
      28000, 30000,
    ]);
  });

  it('labels all 24 ranks', () => {
    expect(LADDER.map((r) => ladderLabel(r.rank))).toEqual([
      'Academy Student', 'Scout', 'Mizunoto', 'Genin', 'Chunin',
      'Shinobi', 'Assassin', 'Firebender', 'Kitsune', 'Lone Wolf',
      'Karasu', 'Jonin', 'Ronin', 'Shogun', 'ANBU', 'Pilot', 'Sannin',
      'Berserk', 'Wizard King', 'Jinchuriki', 'Newtype', 'Overlord',
      'Shadow Monarch', 'Pirate King',
    ]);
  });

  it('gives every rank a Cloudinary icon URL and a bundled asset', () => {
    for (const info of LADDER) {
      expect(info.iconUrl).toContain('res.cloudinary.com/chirkut/');
      expect(info.iconUrl.endsWith('.webp')).toBe(true);
      expect(typeof info.iconAsset).toBe('number');
    }
  });

  it('falls back to Academy Student for an unknown slug', () => {
    expect(ladderInfo('kage').rank).toBe('academy-student');
    expect(ladderLabel('nonsense')).toBe('Academy Student');
  });
});

describe('ladderForRp', () => {
  it('matches the spec worked example: 5,340 RP -> Jonin', () => {
    const s = ladderForRp(5340);
    expect(s.rank).toBe('jonin');
    expect(s.index).toBe(11);
    expect(s.nextRank).toBe('shogun');
    expect(s.toNext).toBe(1660);
    expect(s.fraction).toBeCloseTo(440 / 2100, 10);
  });

  it('handles the first-rank edges', () => {
    expect(ladderForRp(0)).toEqual({
      rank: 'academy-student',
      index: 0,
      nextRank: 'mizunoto',
      toNext: 250,
      fraction: 0,
    });
    expect(ladderForRp(99).rank).toBe('academy-student');
    expect(ladderForRp(100).rank).toBe('scout');
    expect(ladderForRp(-50).rank).toBe('academy-student');
  });

  it('handles the last-rank edges (Pirate King is open-ended)', () => {
    expect(ladderForRp(29999).rank).toBe('shadow-monarch');
    expect(ladderForRp(29999).nextRank).toBe('pirate-king');
    expect(ladderForRp(29999).toNext).toBe(1);
    expect(ladderForRp(30000)).toEqual({
      rank: 'pirate-king',
      index: 23,
      nextRank: null,
      toNext: 0,
      fraction: 1,
    });
    expect(ladderForRp(31240).rank).toBe('pirate-king');
    expect(ladderForRp(999999).fraction).toBe(1);
  });

  it('derives every threshold boundary like the API mirror', () => {
    LADDER.forEach((entry, i) => {
      expect(ladderForRp(entry.min).rank).toBe(entry.rank);
      expect(ladderForRp(entry.min).index).toBe(i);
      if (i > 0) {
        expect(ladderForRp(entry.min - 1).rank).toBe(LADDER[i - 1].rank);
      }
    });
  });
});

describe('standingOf / formatRp', () => {
  it('prefers the served ladder field, derives otherwise', () => {
    const served = {
      rank: 'jonin' as const,
      index: 11,
      nextRank: 'shogun' as const,
      toNext: 1660,
      fraction: 440 / 2100,
    };
    expect(standingOf({ rp: 5340, ladder: served })).toBe(served);
    expect(standingOf({ rp: 5340 }).rank).toBe('jonin');
  });

  it('groups RP figures', () => {
    expect(formatRp(5340)).toBe('5,340 RP');
    expect(formatRp(0)).toBe('0 RP');
  });
});
