import { describe, expect, it } from '@jest/globals';
import { countdownSecondsLeft } from './quizTiming';
import { countUpValue } from './countUp';
import { isPlayerRouteOrigin } from './queueOrigin';

/**
 * Quiz countdown derivation (src/quizTiming.ts): whole seconds
 * until the round opens, partial seconds rounding UP, clamped
 * at zero once the window is open.
 */
describe('countdownSecondsLeft', () => {
  const OPEN = 1_700_000_000_000;

  it('counts whole seconds, rounding partial seconds up', () => {
    expect(countdownSecondsLeft(OPEN, OPEN - 5000)).toBe(5);
    expect(countdownSecondsLeft(OPEN, OPEN - 4200)).toBe(5);
    expect(countdownSecondsLeft(OPEN, OPEN - 4000)).toBe(4);
    expect(countdownSecondsLeft(OPEN, OPEN - 1)).toBe(1);
  });

  it('is zero at and after the opening instant', () => {
    expect(countdownSecondsLeft(OPEN, OPEN)).toBe(0);
    expect(countdownSecondsLeft(OPEN, OPEN + 60_000)).toBe(0);
  });
});

/**
 * Count-up interpolation (src/countUp.ts): ease-out cubic from
 * `from` to `target` — exact endpoints, monotonic, never past
 * the target in either direction.
 */
describe('countUpValue', () => {
  it('pins the endpoints and clamps out-of-range progress', () => {
    expect(countUpValue(0, 950, 0)).toBe(0);
    expect(countUpValue(0, 950, 1)).toBe(950);
    expect(countUpValue(0, 950, -0.5)).toBe(0);
    expect(countUpValue(0, 950, 1.5)).toBe(950);
    expect(countUpValue(200, 200, 0.5)).toBe(200);
  });

  it('eases out: past the linear midpoint early, exact at the end', () => {
    // t=0.5 → eased 0.875 → 875 of the way.
    expect(countUpValue(0, 1000, 0.5)).toBe(875);
    let previous = -1;
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const value = countUpValue(0, 950, t);
      expect(value).toBeGreaterThanOrEqual(previous);
      expect(value).toBeLessThanOrEqual(950);
      previous = value;
    }
  });

  it('counts DOWN without undershooting when the target drops', () => {
    expect(countUpValue(500, 100, 0.5)).toBe(150);
    expect(countUpValue(500, 100, 1)).toBe(100);
  });
});

/**
 * Queue-origin ruling (src/queueOrigin.ts): only playlist
 * and downloads ('offline') queues may open the full-screen
 * player route; every other origin goes to theme detail.
 */
describe('isPlayerRouteOrigin', () => {
  it('allows playlist and offline, refuses other', () => {
    expect(isPlayerRouteOrigin('playlist')).toBe(true);
    expect(isPlayerRouteOrigin('offline')).toBe(true);
    expect(isPlayerRouteOrigin('other')).toBe(false);
  });
});
