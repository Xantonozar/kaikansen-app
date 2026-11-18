import { shell, spacing } from './theme';

/**
 * Bottom clearance for scroll containers that live under the
 * app's floating bottom chrome (owner report, 2026-11-18: on the
 * tab screens the last rows slid under the mini player + pill
 * nav and were cut off — the screens carried only a static
 * spacing.xxxl paddingBottom).
 *
 * ONE shared mechanism instead of per-screen constants: every
 * primary scroll container takes its paddingBottom from here
 * (through src/useBottomInset.ts), so the clearance tracks the
 * two things that actually occupy the bottom of the screen:
 *
 * - the floating pill tab bar — always present on tab screens:
 *   shell.tabBarHeight plus its bottom margin (spacing.sm +
 *   half the device safe-area inset, exactly the margin the
 *   TabBar itself applies);
 * - the mini player — present only while a session is loaded:
 *   on tab screens it sits IN the tab bar's flow above the pill
 *   (card + its wrap margins); on pushed screens it floats as
 *   an overlay card (card + its bottom offset).
 *
 * …plus a comfortable gap (spacing.lg) so the last row never
 * kisses the chrome. When nothing is playing, tab screens fall
 * back to nav clearance + gap and pushed screens to the plain
 * spacing.xxxl they always had.
 *
 * The heights below are DERIVED from the components' own style
 * values (MiniPlayer card: 44px content row — the play disc —
 * plus (spacing.sm + 2) vertical padding; wrapInBar margins
 * spacing.sm top/bottom; wrapOverlay bottom spacing.md + 2), so
 * a restyle of those components should update them here.
 */

/** Mini player card height: the 44px disc row + vertical padding. */
export const MINI_PLAYER_CARD_HEIGHT = 44 + (spacing.sm + 2) * 2;

/** The block the mini player occupies above the pill bar on tab
    screens (card + the in-bar wrap's top/bottom margins). */
export const MINI_PLAYER_TAB_BLOCK_HEIGHT =
  MINI_PLAYER_CARD_HEIGHT + spacing.sm * 2;

/** Bottom offset of the overlay mini player on pushed screens. */
export const MINI_PLAYER_OVERLAY_BOTTOM = spacing.md + 2;

/** Breathing room between the last row and the chrome. */
export const BOTTOM_INSET_GAP = spacing.lg;

/** Space the floating pill bar itself claims from the screen's
    bottom edge: its height plus its bottom margin (spacing.sm +
    half the safe-area inset — the TabBar's own margin formula). */
export function tabBarClearance(safeAreaBottom: number): number {
  return (
    shell.tabBarHeight + spacing.sm + Math.round(safeAreaBottom / 2)
  );
}

/** paddingBottom for a TAB screen's primary scroll container. */
export function tabBottomInset(input: {
  miniPlayerVisible: boolean;
  safeAreaBottom: number;
}): number {
  return (
    tabBarClearance(input.safeAreaBottom) +
    (input.miniPlayerVisible ? MINI_PLAYER_TAB_BLOCK_HEIGHT : 0) +
    BOTTOM_INSET_GAP
  );
}

/** paddingBottom for a PUSHED screen's primary scroll container
    (no pill nav there — only the overlay mini player floats). */
export function overlayBottomInset(input: {
  miniPlayerVisible: boolean;
}): number {
  return input.miniPlayerVisible
    ? MINI_PLAYER_OVERLAY_BOTTOM + MINI_PLAYER_CARD_HEIGHT + BOTTOM_INSET_GAP
    : spacing.xxxl;
}
