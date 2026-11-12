import type { PlaybackMode } from '@kaikansen/contracts';

/**
 * The history-recording decision, extracted pure from
 * usePlayback's history effect (counts fix, 2026-11-12) so the
 * fire-once semantics are unit-pinned without a render harness.
 *
 * The rule (owner's counting definition): when playback of an
 * entry+mode first truly starts, POST /library/history fires
 * once — a play counts by what was consumed (the session mode:
 * audio = a listen, video = a view). Resumes/seeks of the same
 * entry+mode never re-fire, and a different entry or mode
 * records again. The guard remembers the LAST settled key only:
 * A→B→A re-records A (the shipped semantics, kept deliberately).
 *
 * RC3 (diagnosis 2026-11-12): the shipped effect wrote its
 * dedupe key BEFORE the request resolved and swallowed
 * failures, so a POST dropped by the cold-starting API
 * permanently ate that entry+mode's record. Here the key is
 * only settled as recorded on SUCCESS; a failed attempt returns
 * to idle, so the next play-state change plans the same
 * entry+mode again. No timers, no background retries — the
 * retry rides the next effect evaluation, exactly like the
 * original fire did.
 */
export interface HistoryRecordState {
  /** Key of the last SUCCESSFULLY recorded play (the once-guard). */
  recordedKey: string | null;
  /** Key of the attempt currently in flight, if any. */
  inFlightKey: string | null;
}

export const INITIAL_HISTORY_RECORD_STATE: HistoryRecordState = {
  recordedKey: null,
  inFlightKey: null,
};

/** The dedupe key for one entry+mode of one theme. */
export function historyRecordKey(
  slug: string,
  atEntryId: number,
  mode: PlaybackMode,
): string {
  return `${slug}:${atEntryId}:${mode}`;
}

/**
 * Decide whether a history POST should fire now. `key` is null
 * whenever the claim has no resolved entry yet (queue claims
 * resolve their detail/entry after claiming); `isPlaying` is
 * the engine's genuine-start signal (an inactive preload claim
 * never plays, so it never fires).
 */
export function planHistoryRecord(
  state: HistoryRecordState,
  input: { isPlaying: boolean; key: string | null },
): { state: HistoryRecordState; fireKey: string | null } {
  if (!input.isPlaying || !input.key) return { state, fireKey: null };
  if (state.recordedKey === input.key) return { state, fireKey: null };
  if (state.inFlightKey === input.key) return { state, fireKey: null };
  return {
    state: { recordedKey: state.recordedKey, inFlightKey: input.key },
    fireKey: input.key,
  };
}

/**
 * Settle an in-flight attempt. Success moves the key into the
 * once-guard; failure just releases the in-flight slot, leaving
 * the key unrecorded so a later plan can fire it again (RC3).
 * A settle for a key that is not in flight is a no-op (a stale
 * promise from a superseded claim must not move the guard).
 */
export function settleHistoryRecord(
  state: HistoryRecordState,
  key: string,
  ok: boolean,
): HistoryRecordState {
  if (state.inFlightKey !== key) return state;
  return ok
    ? { recordedKey: key, inFlightKey: null }
    : { recordedKey: state.recordedKey, inFlightKey: null };
}
