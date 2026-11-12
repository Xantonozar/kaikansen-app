import type { QuizRoomStatus } from '@kaikansen/contracts';

/**
 * Room-session reconciliation (1.0.8, C1) — the room screen
 * keeps the finished match's ephemera in local state: the last
 * `room:round-ended` event (whose `gameOver` flag pins the
 * screen to the Final standings phase) and the per-player
 * `room:rank-updated` results. That state belongs to ONE match
 * in ONE room. When the authoritative room state is (re)fetched
 * — mount, reconnect, a broadcast that carries no full state —
 * and it describes a DIFFERENT situation than the ephemera
 * (a waiting room, or a new match already in progress after a
 * rematch), the ephemera is stale and must be dropped,
 * otherwise the screen resurrects the old match's standings
 * page over the new room (the "New room shows the finish page"
 * bug: the button navigated without leaving, and nothing ever
 * cleared the finished state).
 *
 * The rule, kept pure so it is pinnable without a renderer:
 * - a WAITING room has no finished match: drop both;
 * - an IN_PROGRESS room whose held round-ended says gameOver
 *   is a NEW match (rematch): drop the event; ranks from the
 *   finished match are dropped for any non-ended room;
 * - an IN_PROGRESS room mid-reveal (round-ended without
 *   gameOver) keeps its event — that IS the live reveal;
 * - an ENDED room keeps both: they are its standings + RP.
 */
export interface ResyncReconciliation {
  dropRoundEnded: boolean;
  dropRanks: boolean;
}

export function reconcileResync(
  nextStatus: QuizRoomStatus,
  held: { roundEndedPresent: boolean; roundEndedGameOver: boolean },
): ResyncReconciliation {
  if (nextStatus === 'ended') {
    return { dropRoundEnded: false, dropRanks: false };
  }
  return {
    dropRoundEnded:
      nextStatus === 'waiting'
        ? held.roundEndedPresent
        : held.roundEndedGameOver,
    dropRanks: true,
  };
}
