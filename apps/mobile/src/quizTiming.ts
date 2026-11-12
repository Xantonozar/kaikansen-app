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

/**
 * F4 round-ready report rule (clock batch, 2026-11-12): the
 * room screen reports its round audio to the server ONCE per
 * round (`room:round-ready`) — 'playing' when the audio is
 * genuinely playing, 'failed' when its chain is exhausted —
 * and the server stamps the round's startedAt once every
 * member has reported. The observation state the screen keeps
 * across phase reports:
 *
 * - `mediaKey`: the round the observations belong to; a new
 *   key resets the observation (a new round starts unreported).
 * - `sawBuffering`: a 'buffering' report was seen FOR THIS KEY.
 * - `reported`: the round's report has been sent.
 *
 * The buffering gate is the stale-level guard: phase reports
 * are levels keyed by mediaKey (F5), and at a round switch the
 * screen can briefly hold the PREVIOUS round's terminal phase
 * ('playing' from a song still sounding, or 'failed') before
 * the new round's player reports. Believing a 'playing' /
 * 'failed' level that arrives without a same-key 'buffering'
 * interlude would report the old round's outcome for the new
 * one — the load effect guarantees the interlude for every
 * real load (it stamps 'loading' at issuance on both legs, and
 * the countdown hold reports 'buffering' throughout), so a
 * genuine decision is never gated out. 'empty' is the one
 * exception: an empty candidate chain is decided by
 * construction (a rejoined round with no media), so it reports
 * 'failed' immediately.
 */
export interface RoundReadyObservation {
  mediaKey: string;
  sawBuffering: boolean;
  reported: boolean;
}

export function observeRoundReadyPhase(
  obs: RoundReadyObservation,
  mediaKey: string,
  phase: 'buffering' | 'playing' | 'failed' | 'empty',
): {
  observation: RoundReadyObservation;
  report: 'playing' | 'failed' | null;
} {
  const current: RoundReadyObservation =
    obs.mediaKey === mediaKey
      ? obs
      : { mediaKey, sawBuffering: false, reported: false };
  if (current.reported) return { observation: current, report: null };
  if (phase === 'buffering') {
    return {
      observation: { ...current, sawBuffering: true },
      report: null,
    };
  }
  if (phase === 'empty') {
    return {
      observation: { ...current, reported: true },
      report: 'failed',
    };
  }
  // 'playing' | 'failed': believed only after this key's
  // buffering interlude (see the docblock).
  if (!current.sawBuffering) return { observation: current, report: null };
  return {
    observation: { ...current, reported: true },
    report: phase === 'playing' ? 'playing' : 'failed',
  };
}
