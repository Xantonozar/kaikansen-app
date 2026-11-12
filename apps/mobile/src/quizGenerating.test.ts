import { describe, expect, it } from '@jest/globals';
import {
  GENERATING_ERROR_MIN_DISPLAY_MS,
  GENERATING_MIN_DISPLAY_MS,
  GENERATING_PROGRESS_CAP,
  GENERATING_STEPS,
  SETUP_MEDIA_BOUND_MS,
  generatingProgressAt,
  generatingStageAt,
  setupWindowShouldExit,
} from './quizGenerating';

describe('generating screen cadence (approved design cfc7c9ac)', () => {
  it('carries the design steps verbatim, in order', () => {
    expect(GENERATING_STEPS).toEqual([
      'Picking your songs',
      'Checking the audio',
      'Lining up your questions',
    ]);
  });

  it('keeps the deliberate 4.5 s setup-window minimum (2026-11-12)', () => {
    // Was 700 ms of anti-flash pacing before the setup window;
    // the window now exists so Q1's pre-mounted player can
    // stream a head start behind the screen (diagnosis §6).
    expect(GENERATING_MIN_DISPLAY_MS).toBe(4500);
    // A failed create still uses the short floor only.
    expect(GENERATING_ERROR_MIN_DISPLAY_MS).toBe(700);
  });

  it('starts on the first step', () => {
    expect(generatingStageAt(0)).toBe(0);
    expect(generatingStageAt(1499)).toBe(0);
  });

  it('completes step 1 at 1500 ms and step 2 at 3000 ms (re-spaced over the window)', () => {
    expect(generatingStageAt(1500)).toBe(1);
    expect(generatingStageAt(2999)).toBe(1);
    expect(generatingStageAt(3000)).toBe(2);
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

describe('setup window exit gate (2026-11-12, diagnosis §6)', () => {
  it('never exits before the create lands, however long the wait', () => {
    expect(
      setupWindowShouldExit({
        createApplied: false,
        elapsedMs: 60_000,
        mediaDecided: true,
        mediaMountedMs: 60_000,
      }),
    ).toBe(false);
  });

  it('never exits inside the 4.5 s minimum, even with media already decided', () => {
    expect(
      setupWindowShouldExit({
        createApplied: true,
        elapsedMs: GENERATING_MIN_DISPLAY_MS - 1,
        mediaDecided: true,
        mediaMountedMs: 1_000,
      }),
    ).toBe(false);
  });

  it('exits at the minimum once Q1 media has decided', () => {
    expect(
      setupWindowShouldExit({
        createApplied: true,
        elapsedMs: GENERATING_MIN_DISPLAY_MS,
        mediaDecided: true,
        mediaMountedMs: 2_000,
      }),
    ).toBe(true);
  });

  it('holds past the minimum while media is undecided, exits at the 10 s mount bound', () => {
    expect(SETUP_MEDIA_BOUND_MS).toBe(10_000);
    expect(
      setupWindowShouldExit({
        createApplied: true,
        elapsedMs: GENERATING_MIN_DISPLAY_MS + 3_000,
        mediaDecided: false,
        mediaMountedMs: SETUP_MEDIA_BOUND_MS - 1,
      }),
    ).toBe(false);
    expect(
      setupWindowShouldExit({
        createApplied: true,
        elapsedMs: GENERATING_MIN_DISPLAY_MS + 6_000,
        mediaDecided: false,
        mediaMountedMs: SETUP_MEDIA_BOUND_MS,
      }),
    ).toBe(true);
  });

  it('a decision landing after the minimum exits immediately (no extra wait)', () => {
    expect(
      setupWindowShouldExit({
        createApplied: true,
        elapsedMs: GENERATING_MIN_DISPLAY_MS + 1_200,
        mediaDecided: true,
        mediaMountedMs: 5_700,
      }),
    ).toBe(true);
  });
});
