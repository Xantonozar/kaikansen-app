import { describe, expect, it } from '@jest/globals';
import { shell, spacing } from './theme';
import {
  MINI_PLAYER_CARD_HEIGHT,
  MINI_PLAYER_OVERLAY_BOTTOM,
  MINI_PLAYER_TAB_BLOCK_HEIGHT,
  overlayBottomInset,
  tabBarClearance,
  tabBottomInset,
} from './bottomInset';

/**
 * Bottom-inset math (owner report, 2026-11-18): the clearance a
 * scroll container needs so its last rows clear the floating
 * pill nav (+ the mini player while a session is loaded). The
 * expectations are written against the components' own style
 * values, so a restyle that changes a height breaks a test here
 * instead of silently re-hiding rows.
 */
describe('bottomInset', () => {
  it('derives the mini player card height from its styles', () => {
    // 44px disc row + (spacing.sm + 2) padding top and bottom.
    expect(MINI_PLAYER_CARD_HEIGHT).toBe(44 + (spacing.sm + 2) * 2);
    // In-bar block adds the wrap's spacing.sm margins.
    expect(MINI_PLAYER_TAB_BLOCK_HEIGHT).toBe(
      MINI_PLAYER_CARD_HEIGHT + spacing.sm * 2,
    );
    // Overlay placement sits spacing.md + 2 off the bottom.
    expect(MINI_PLAYER_OVERLAY_BOTTOM).toBe(spacing.md + 2);
  });

  it('clears the pill bar: height + bottom margin formula', () => {
    expect(tabBarClearance(0)).toBe(shell.tabBarHeight + spacing.sm);
    expect(tabBarClearance(24)).toBe(
      shell.tabBarHeight + spacing.sm + 12,
    );
    // Odd insets round like the TabBar's own margin does.
    expect(tabBarClearance(25)).toBe(
      shell.tabBarHeight + spacing.sm + 13,
    );
  });

  it('tab inset without playback is nav clearance + gap', () => {
    const inset = tabBottomInset({
      miniPlayerVisible: false,
      safeAreaBottom: 24,
    });
    expect(inset).toBe(tabBarClearance(24) + spacing.lg);
    // Always more than the old static padding that hid rows.
    expect(inset).toBeGreaterThan(spacing.xxxl);
  });

  it('tab inset grows by the mini player block while playing', () => {
    const idle = tabBottomInset({
      miniPlayerVisible: false,
      safeAreaBottom: 24,
    });
    const playing = tabBottomInset({
      miniPlayerVisible: true,
      safeAreaBottom: 24,
    });
    expect(playing - idle).toBe(MINI_PLAYER_TAB_BLOCK_HEIGHT);
  });

  it('overlay inset is the plain static padding when idle', () => {
    expect(overlayBottomInset({ miniPlayerVisible: false })).toBe(
      spacing.xxxl,
    );
  });

  it('overlay inset clears the floating card while playing', () => {
    expect(overlayBottomInset({ miniPlayerVisible: true })).toBe(
      MINI_PLAYER_OVERLAY_BOTTOM + MINI_PLAYER_CARD_HEIGHT + spacing.lg,
    );
  });
});
