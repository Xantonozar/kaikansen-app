import { describe, expect, it } from '@jest/globals';
import {
  historyRecordKey,
  INITIAL_HISTORY_RECORD_STATE,
  planHistoryRecord,
  settleHistoryRecord,
  type HistoryRecordState,
} from './historyRecording';

/**
 * The history-recording decision (counts fix, 2026-11-12) —
 * the pins the counts diagnosis (§6) asked for, against the
 * pure extraction the effect in usePlayback.ts now rides:
 * (2) fires once on first playing, re-fires after a failed
 * POST, never fires for an inactive/unresolved claim;
 * (4) repeat-one and A→B→A semantics under the settled-key
 * rule (diagnosis pin 4, RC3 ruling: success settles, failure
 * releases).
 */

const KEY_A = historyRecordKey('theme-a', 1, 'listen');
const KEY_A_WATCH = historyRecordKey('theme-a', 1, 'watch');
const KEY_B = historyRecordKey('theme-b', 2, 'listen');

function playing(state: HistoryRecordState, key: string | null) {
  return planHistoryRecord(state, { isPlaying: true, key });
}

describe('historyRecordKey', () => {
  it('keys by slug + entry + mode (a mode switch is a new record)', () => {
    expect(KEY_A).toBe('theme-a:1:listen');
    expect(KEY_A_WATCH).toBe('theme-a:1:watch');
    expect(KEY_A).not.toBe(KEY_A_WATCH);
  });
});

describe('planHistoryRecord — the fire decision', () => {
  it('fires once when playback first truly starts', () => {
    const first = playing(INITIAL_HISTORY_RECORD_STATE, KEY_A);
    expect(first.fireKey).toBe(KEY_A);
    // The same play state re-evaluated while the POST is in
    // flight does not fire a second copy.
    const again = playing(first.state, KEY_A);
    expect(again.fireKey).toBeNull();
  });

  it('never fires for an inactive claim (not playing) or an unresolved entry (no key)', () => {
    expect(
      planHistoryRecord(INITIAL_HISTORY_RECORD_STATE, {
        isPlaying: false,
        key: KEY_A,
      }).fireKey,
    ).toBeNull();
    expect(playing(INITIAL_HISTORY_RECORD_STATE, null).fireKey).toBeNull();
  });

  it('a different entry or mode records again', () => {
    const a = playing(INITIAL_HISTORY_RECORD_STATE, KEY_A);
    const settledA = settleHistoryRecord(a.state, KEY_A, true);
    expect(playing(settledA, KEY_B).fireKey).toBe(KEY_B);
    expect(playing(settledA, KEY_A_WATCH).fireKey).toBe(KEY_A_WATCH);
  });
});

describe('settleHistoryRecord — RC3: the key settles only on success', () => {
  it('after a FAILED post the same entry+mode fires again on the next play-state change', () => {
    const attempt = playing(INITIAL_HISTORY_RECORD_STATE, KEY_A);
    expect(attempt.fireKey).toBe(KEY_A);
    const failed = settleHistoryRecord(attempt.state, KEY_A, false);
    // Not recorded, nothing in flight — the record is not eaten.
    expect(failed).toEqual(INITIAL_HISTORY_RECORD_STATE);
    const retry = playing(failed, KEY_A);
    expect(retry.fireKey).toBe(KEY_A);
    // And once the retry lands, the once-guard holds.
    const settled = settleHistoryRecord(retry.state, KEY_A, true);
    expect(playing(settled, KEY_A).fireKey).toBeNull();
  });

  it('after a successful post the same entry+mode never re-fires (resumes, seeks, repeat-one)', () => {
    const attempt = playing(INITIAL_HISTORY_RECORD_STATE, KEY_A);
    const settled = settleHistoryRecord(attempt.state, KEY_A, true);
    expect(settled.recordedKey).toBe(KEY_A);
    // Pause → resume / repeat-one replay: isPlaying cycles, the
    // key is settled, no second count.
    expect(playing(settled, KEY_A).fireKey).toBeNull();
  });

  it('A→B→A re-records A (the guard holds the last settled key only)', () => {
    const a1 = playing(INITIAL_HISTORY_RECORD_STATE, KEY_A);
    const sA = settleHistoryRecord(a1.state, KEY_A, true);
    const b = playing(sA, KEY_B);
    const sB = settleHistoryRecord(b.state, KEY_B, true);
    expect(sB.recordedKey).toBe(KEY_B);
    expect(playing(sB, KEY_A).fireKey).toBe(KEY_A);
  });

  it('a stale settle (key no longer in flight) moves nothing', () => {
    const attempt = playing(INITIAL_HISTORY_RECORD_STATE, KEY_A);
    const other = settleHistoryRecord(attempt.state, KEY_B, true);
    expect(other).toBe(attempt.state);
    expect(other.recordedKey).toBeNull();
    expect(other.inFlightKey).toBe(KEY_A);
  });
});
