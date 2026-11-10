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
 * mirror of the API's ladderForRp suite: same thresholds (Curve B,
 * spec RANK-RP-PLAN-2026-11-11.md), same progress-target rule
 * (the NEXT rank).
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
      0, 100, 250, 450, 700, 1100, 1600, 2300, 3200, 4200, 5400, 6800,
      8400, 10200, 12200, 14500, 17000, 19800, 22800, 25800, 28800, 31800,
      33400, 35000,
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
  it('matches the plan worked examples (spec RANK-RP-PLAN-2026-11-11)', () => {
    // 710 RP → Chunin, 390 to Shinobi, fraction (710−700)/(1100−700).
    expect(ladderForRp(710)).toEqual({
      rank: 'chunin',
      index: 4,
      nextRank: 'shinobi',
      toNext: 390,
      fraction: 10 / 400,
    });
    // 600 RP → Genin, 100 to Chunin — the NEXT rank (see the
    // API mirror's note: the plan sketch's "500 to Shinobi" for
    // 600 RP is the retired aim-ahead arithmetic).
    const ddd = ladderForRp(600);
    expect(ddd.rank).toBe('genin');
    expect(ddd.nextRank).toBe('chunin');
    expect(ddd.toNext).toBe(100);
    // 195 RP → Scout, 55 to Mizunoto (the NEXT rank — see the
    // API mirror's note on the sketch's aim-ahead slip).
    const ccc = ladderForRp(195);
    expect(ccc.rank).toBe('scout');
    expect(ccc.nextRank).toBe('mizunoto');
    expect(ccc.toNext).toBe(55);
  });

  it('has NO floor: an RP drop below a threshold demotes', () => {
    expect(ladderForRp(710).rank).toBe('chunin');
    expect(ladderForRp(690).rank).toBe('genin');
    expect(ladderForRp(699).rank).toBe('genin');
    expect(ladderForRp(700).rank).toBe('chunin');
  });

  it('handles the first-rank edges', () => {
    expect(ladderForRp(0)).toEqual({
      rank: 'academy-student',
      index: 0,
      nextRank: 'scout',
      toNext: 100,
      fraction: 0,
    });
    expect(ladderForRp(99).rank).toBe('academy-student');
    expect(ladderForRp(100).rank).toBe('scout');
    expect(ladderForRp(-50).rank).toBe('academy-student');
  });

  it('handles the last-rank edges (Pirate King is open-ended)', () => {
    expect(ladderForRp(34999).rank).toBe('shadow-monarch');
    expect(ladderForRp(34999).nextRank).toBe('pirate-king');
    expect(ladderForRp(34999).toNext).toBe(1);
    expect(ladderForRp(35000)).toEqual({
      rank: 'pirate-king',
      index: 23,
      nextRank: null,
      toNext: 0,
      fraction: 1,
    });
    expect(ladderForRp(41240).rank).toBe('pirate-king');
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
      nextRank: 'ronin' as const,
      toNext: 1400,
      fraction: 440 / 1600,
    };
    expect(standingOf({ rp: 7240, ladder: served })).toBe(served);
    expect(standingOf({ rp: 7240 }).rank).toBe('jonin');
  });

  it('groups RP figures', () => {
    expect(formatRp(5340)).toBe('5,340 RP');
    expect(formatRp(0)).toBe('0 RP');
  });
});
