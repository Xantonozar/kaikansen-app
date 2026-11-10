import { ladderForRp } from './quiz-game.utils';

/**
 * THE app's ladder standing derivation (spec
 * RANK-RP-PLAN-2026-11-11.md) — the single seam every app-side
 * read of a player's CURRENT standing goes through: rank reads,
 * leaderboards, network rows, the rank-updated event.
 *
 * NO FLOOR (owner decision 2026-11-11: the rank floor is
 * DROPPED). Until this seam existed, current standings on the
 * profile-shaped reads were derived from
 * `Math.max(rp, stats.peakRP)` — the peak is a historical
 * high-water mark, so the standing could only ever ratchet UP:
 * a player whose RP had fallen still showed the rank their peak
 * had once earned. That max() WAS the floor the ladder
 * inherited from the website's tier engine (whose own clamp —
 * RankService's `tierFloor` write arithmetic — is the web's
 * shared behaviour and deliberately NOT touched: stored
 * documents keep moving exactly as the website moves them).
 *
 * Here the clamp is neutralised where it fed the LADDER and
 * nowhere else: a standing derives from the player's current RP
 * alone, so falling below a threshold demotes the derived rank.
 * `stats.peakRP` still feeds `peakRank` / `peakLadderRank` —
 * labelled historical facts, unchanged.
 *
 * Derived, never stored: nothing here writes to the shared
 * `userranks` documents.
 */
export function ladderStandingFor(rp: number) {
  return ladderForRp(rp);
}

/**
 * The pure table derivation, re-exported so ladder specs and
 * tools can pin the table itself through the same module the
 * read paths use.
 */
export { ladderForRp };
