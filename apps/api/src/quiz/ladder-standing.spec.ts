import { ladderForRp } from './quiz-game.utils';
import { ladderStandingFor, weekStartDhaka } from './ladder-standing';

/**
 * The app's standing seam (spec RANK-RP-PLAN-2026-11-11.md):
 * current standings derive from CURRENT RP alone — the rank
 * floor is dropped, so the derivation never consults a peak.
 */
describe('ladderStandingFor (no-floor standing seam)', () => {
  it('is the pure ladder derivation of the RP handed in', () => {
    for (const rp of [0, 100, 195, 600, 690, 700, 710, 5340, 35000]) {
      expect(ladderStandingFor(rp)).toEqual(ladderForRp(rp));
    }
  });

  it('demotes when RP falls below the current rank threshold', () => {
    // 710 RP is Chunin; 690 is not — nothing holds the rank.
    expect(ladderStandingFor(710).rank).toBe('chunin');
    expect(ladderStandingFor(690).rank).toBe('genin');
    expect(ladderStandingFor(699).rank).toBe('genin');
    expect(ladderStandingFor(700).rank).toBe('chunin');
  });

  it('takes no peak input: a high-water mark cannot prop a standing up', () => {
    // The seam's whole contract is its signature — one number
    // in, the standing of THAT number out. (The read-path proof
    // that a document's peakRP no longer feeds the standing
    // lives in rank-read.service.spec: a doc at 690 RP with a
    // 900 peak serves Genin with a Chunin peakRank.)
    expect(ladderStandingFor).toHaveLength(1);
  });
});

/**
 * The weekly board's week boundary (fix batch 2026-11-11):
 * Monday 00:00:00.000 Asia/Dhaka (UTC+06:00). Reference week:
 * Monday 2026-11-09 00:00 +06 = 2026-11-08T18:00:00.000Z.
 */
describe('weekStartDhaka', () => {
  const MONDAY = '2026-11-08T18:00:00.000Z';

  it('a moment exactly at Monday 00:00 Dhaka starts a new week there', () => {
    expect(weekStartDhaka(new Date(MONDAY)).toISOString()).toBe(MONDAY);
  });

  it('Sunday 23:59 Dhaka still belongs to the week that began the Monday before', () => {
    // Sunday 2026-11-08 23:59 +06 = 17:59Z — its week began
    // Monday 2026-11-02 00:00 +06 = 2026-11-01T18:00Z.
    expect(
      weekStartDhaka(new Date('2026-11-08T17:59:00.000Z')).toISOString(),
    ).toBe('2026-11-01T18:00:00.000Z');
  });

  it('one minute into Monday Dhaka is already the new week', () => {
    expect(
      weekStartDhaka(new Date('2026-11-08T18:01:00.000Z')).toISOString(),
    ).toBe(MONDAY);
  });

  it('mid-week (Wednesday Dhaka) resolves to that week’s Monday', () => {
    // Wednesday 2026-11-11 12:00 +06 = 06:00Z.
    expect(
      weekStartDhaka(new Date('2026-11-11T06:00:00.000Z')).toISOString(),
    ).toBe(MONDAY);
  });

  it('Sunday Dhaka belongs to the week ending that night', () => {
    // Sunday 2026-11-15 10:00 +06 = 04:00Z — week of Mon 11-09.
    expect(
      weekStartDhaka(new Date('2026-11-15T04:00:00.000Z')).toISOString(),
    ).toBe(MONDAY);
  });
});
