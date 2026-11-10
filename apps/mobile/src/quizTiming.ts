/**
 * Quiz timing helpers (extracted from the room screen for the
 * mobile test foundation, audit S6).
 *
 * Whole seconds left in the pre-round countdown: the multiplayer
 * broadcast's startedAt sits ROUND_COUNTDOWN_SECONDS in the
 * future while clients preload the round audio, and every client
 * derives its display from that one timestamp, so the whole room
 * counts the same countdown. Partial seconds round UP (a round
 * opening in 4.2s still shows 5, then 4 at the next whole
 * second); the value clamps at 0 once the answer window is open.
 */
export function countdownSecondsLeft(opensAtMs: number, nowMs: number): number {
  return Math.max(0, Math.ceil((opensAtMs - nowMs) / 1000));
}
