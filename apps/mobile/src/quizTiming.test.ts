import { describe, expect, it } from '@jest/globals';
import {
  countdownSecondsLeft,
  observeRoundReadyPhase,
  type RoundReadyObservation,
} from './quizTiming';

describe('countdownSecondsLeft', () => {
  it('rounds partial seconds up and clamps at 0', () => {
    expect(countdownSecondsLeft(10_000, 5_800)).toBe(5);
    expect(countdownSecondsLeft(10_000, 6_000)).toBe(4);
    expect(countdownSecondsLeft(10_000, 10_000)).toBe(0);
    expect(countdownSecondsLeft(10_000, 12_000)).toBe(0);
  });
});

describe('observeRoundReadyPhase (F4, 2026-11-12)', () => {
  const fresh = (): RoundReadyObservation => ({
    mediaKey: '',
    sawBuffering: false,
    reported: false,
  });
  const KEY = 'room-1:1';

  it('buffering then playing reports playing, exactly once', () => {
    let obs = fresh();
    let r = observeRoundReadyPhase(obs, KEY, 'buffering');
    expect(r.report).toBeNull();
    obs = r.observation;
    r = observeRoundReadyPhase(obs, KEY, 'playing');
    expect(r.report).toBe('playing');
    obs = r.observation;
    // Latched: later levels (even a flip to failed) never re-report.
    r = observeRoundReadyPhase(obs, KEY, 'failed');
    expect(r.report).toBeNull();
    r = observeRoundReadyPhase(obs, KEY, 'playing');
    expect(r.report).toBeNull();
  });

  it('buffering then failed reports failed', () => {
    let obs = fresh();
    obs = observeRoundReadyPhase(obs, KEY, 'buffering').observation;
    const r = observeRoundReadyPhase(obs, KEY, 'failed');
    expect(r.report).toBe('failed');
  });

  it("a stale 'playing' level with no same-key buffering interlude is NOT believed", () => {
    // The round-switch hazard: the previous round's song is
    // still sounding under its own key when the new round's
    // first report is read — it must not report for this round.
    const r = observeRoundReadyPhase(fresh(), KEY, 'playing');
    expect(r.report).toBeNull();
    const r2 = observeRoundReadyPhase(fresh(), KEY, 'failed');
    expect(r2.report).toBeNull();
  });

  it("an 'empty' phase reports failed immediately (decided by construction)", () => {
    const r = observeRoundReadyPhase(fresh(), KEY, 'empty');
    expect(r.report).toBe('failed');
  });

  it('a new mediaKey resets the observation (the next round reports afresh)', () => {
    let obs = fresh();
    obs = observeRoundReadyPhase(obs, KEY, 'buffering').observation;
    obs = observeRoundReadyPhase(obs, KEY, 'playing').observation;
    // Round 2 under a new key: buffering interlude, then playing.
    const key2 = 'room-1:2';
    let r = observeRoundReadyPhase(obs, key2, 'buffering');
    expect(r.report).toBeNull();
    r = observeRoundReadyPhase(r.observation, key2, 'playing');
    expect(r.report).toBe('playing');
  });

  it('repeated buffering never reports', () => {
    let obs = fresh();
    for (let i = 0; i < 3; i++) {
      const r = observeRoundReadyPhase(obs, KEY, 'buffering');
      expect(r.report).toBeNull();
      obs = r.observation;
    }
    expect(obs.sawBuffering).toBe(true);
    expect(obs.reported).toBe(false);
  });
});
