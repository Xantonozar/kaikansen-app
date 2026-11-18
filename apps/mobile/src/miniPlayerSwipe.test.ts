import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from '@jest/globals';
import {
  MINI_PLAYER_DISMISS_DISTANCE,
  MINI_PLAYER_DISMISS_VELOCITY,
  miniPlayerDismissTargetX,
  miniPlayerSwipeOpacity,
  shouldDismissMiniPlayer,
} from './miniPlayerSwipe';

/**
 * Swipe-to-dismiss pins (owner order, 2026-11-16): both
 * directions cancel the mini player; a short slow drag springs
 * back; the exit target is off the edge it travelled toward.
 */

describe('shouldDismissMiniPlayer', () => {
  it('dismisses past the distance threshold, either direction', () => {
    expect(shouldDismissMiniPlayer(MINI_PLAYER_DISMISS_DISTANCE, 0)).toBe(true);
    expect(shouldDismissMiniPlayer(-MINI_PLAYER_DISMISS_DISTANCE, 0)).toBe(true);
    expect(shouldDismissMiniPlayer(240, 0)).toBe(true);
  });

  it('keeps the bar for a short, slow drag', () => {
    expect(shouldDismissMiniPlayer(MINI_PLAYER_DISMISS_DISTANCE - 1, 0)).toBe(false);
    expect(shouldDismissMiniPlayer(0, 0)).toBe(false);
    expect(shouldDismissMiniPlayer(-40, -120)).toBe(false);
  });

  it('a flick dismisses even under the distance threshold', () => {
    expect(shouldDismissMiniPlayer(30, MINI_PLAYER_DISMISS_VELOCITY)).toBe(true);
    expect(shouldDismissMiniPlayer(-30, -MINI_PLAYER_DISMISS_VELOCITY)).toBe(true);
    expect(shouldDismissMiniPlayer(30, MINI_PLAYER_DISMISS_VELOCITY - 1)).toBe(false);
  });
});

describe('miniPlayerDismissTargetX', () => {
  it('exits past the edge in the drag direction', () => {
    expect(miniPlayerDismissTargetX(150, 0, 400)).toBe(440);
    expect(miniPlayerDismissTargetX(-150, 0, 400)).toBe(-440);
  });

  it('a flick’s direction wins over a small opposing drag', () => {
    expect(miniPlayerDismissTargetX(20, -900, 400)).toBe(-440);
    expect(miniPlayerDismissTargetX(-20, 900, 400)).toBe(440);
  });
});

describe('miniPlayerSwipeOpacity', () => {
  it('is opaque at rest and fades with travel', () => {
    expect(miniPlayerSwipeOpacity(0)).toBe(1);
    expect(miniPlayerSwipeOpacity(MINI_PLAYER_DISMISS_DISTANCE)).toBe(0.5);
    expect(miniPlayerSwipeOpacity(-MINI_PLAYER_DISMISS_DISTANCE)).toBe(0.5);
    expect(miniPlayerSwipeOpacity(9999)).toBe(0);
  });
});

describe('MiniPlayer wiring (source scan)', () => {
  const source = readFileSync(
    join(__dirname, 'components/MiniPlayer.tsx'),
    'utf8',
  );

  it('wraps the bar in the pan gesture and dismisses via endSession', () => {
    expect(source).toContain('GestureDetector');
    expect(source).toContain('shouldDismissMiniPlayer(');
    expect(source).toContain('endSessionRef.current()');
    // Horizontal-only activation: taps and vertical scrolls
    // must never be stolen by the dismiss gesture.
    expect(source).toContain('activeOffsetX([-12, 12])');
    expect(source).toContain('failOffsetY([-12, 12])');
  });
});
