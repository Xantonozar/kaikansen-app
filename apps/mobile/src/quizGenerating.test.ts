import { describe, expect, it } from '@jest/globals';
import {
  GENERATING_MIN_DISPLAY_MS,
  GENERATING_PROGRESS_CAP,
  GENERATING_STEPS,
  generatingProgressAt,
  generatingStageAt,
} from './quizGenerating';

describe('generating screen cadence (approved design cfc7c9ac)', () => {
  it('carries the design steps verbatim, in order', () => {
    expect(GENERATING_STEPS).toEqual([
      'Picking your songs',
      'Checking the audio',
      'Lining up your questions',
    ]);
  });

  it('keeps a 700 ms minimum display (inside the 600–900 brief)', () => {
    expect(GENERATING_MIN_DISPLAY_MS).toBe(700);
  });

  it('starts on the first step', () => {
    expect(generatingStageAt(0)).toBe(0);
    expect(generatingStageAt(599)).toBe(0);
  });

  it('completes step 1 at 600 ms and step 2 at 2000 ms', () => {
    expect(generatingStageAt(600)).toBe(1);
    expect(generatingStageAt(1999)).toBe(1);
    expect(generatingStageAt(2000)).toBe(2);
  });

  it('never advances past the last step, however long the wait', () => {
    expect(generatingStageAt(60_000)).toBe(2);
    expect(generatingStageAt(Number.MAX_SAFE_INTEGER)).toBe(2);
  });
});

describe('generating screen progress (never claims completion)', () => {
  it('starts empty and stays at 0 for non-positive elapsed', () => {
    expect(generatingProgressAt(0)).toBe(0);
    expect(generatingProgressAt(-500)).toBe(0);
  });

  it('rests near the design fill (~60%) around 2 s', () => {
    expect(generatingProgressAt(2000)).toBeGreaterThan(0.55);
    expect(generatingProgressAt(2000)).toBeLessThan(0.65);
  });

  it('increases monotonically', () => {
    let prev = -1;
    for (const ms of [0, 300, 600, 1200, 2000, 4000, 8000, 20000]) {
      const p = generatingProgressAt(ms);
      expect(p).toBeGreaterThan(prev);
      prev = p;
    }
  });

  it('never exceeds the cap, let alone 100%', () => {
    expect(GENERATING_PROGRESS_CAP).toBeLessThan(1);
    // Minutes into a wait the exponential float-saturates AT
    // the cap — the invariant that matters is the bar never
    // passes it and never reads full.
    expect(generatingProgressAt(10 * 60_000)).toBeLessThanOrEqual(
      GENERATING_PROGRESS_CAP,
    );
    expect(generatingProgressAt(10 * 60_000)).toBeGreaterThan(0.85);
    expect(generatingProgressAt(10 * 60_000)).toBeLessThan(1);
  });
});
