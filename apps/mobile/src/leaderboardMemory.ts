/* Leaderboard paint-first memory — the owner's addendum
   (2026-11-11): the last successfully loaded entries for each
   scope, kept in a session-level (module) store so a revisit
   paints instantly while the fetch refreshes behind it.

   Paint-first ONLY: this never replaces a fetch — every load
   still runs the network read (the Weekly board's fix-batch
   freshness rule: RP changes show immediately). A failure
   against a remembered board keeps the remembered rows and
   stays silent; a failure with no memory keeps the error
   state. Session-scoped (module singleton) — NOT disk, NOT
   apiCache. */

import type { RankLeaderboardEntry } from '@kaikansen/contracts';

export type LeaderboardScope = 'all-time' | 'weekly';

const remembered = new Map<LeaderboardScope, RankLeaderboardEntry[]>();

/** The remembered board for a scope, or null on a cold visit. */
export function rememberedBoard(
  scope: LeaderboardScope,
): RankLeaderboardEntry[] | null {
  return remembered.get(scope) ?? null;
}

/** Stores a scope's freshly loaded entries (success only —
    callers never put on failure). */
export function rememberBoard(
  scope: LeaderboardScope,
  entries: RankLeaderboardEntry[],
): void {
  remembered.set(scope, entries);
}

/** Clears the whole session memory (tests; parity with the
    other session stores' clear seams). */
export function clearBoardMemory(): void {
  remembered.clear();
}

export type BoardLoadDecision =
  /** No memory: show the skeleton, errors surface. */
  | { paint: null; showErrorOnFailure: true }
  /** Paint the remembered rows instantly; a failure keeps
      them and stays silent. */
  | { paint: RankLeaderboardEntry[]; showErrorOnFailure: false };

/** The load decision for a scope — pure, testable. */
export function planBoardLoad(scope: LeaderboardScope): BoardLoadDecision {
  const paint = rememberedBoard(scope);
  return paint === null
    ? { paint: null, showErrorOnFailure: true }
    : { paint, showErrorOnFailure: false };
}
