import { ladderForRp } from './quiz-game.utils';
import { ladderStandingFor } from './ladder-standing';

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
