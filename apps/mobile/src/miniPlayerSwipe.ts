/**
 * Mini player swipe-to-dismiss math (owner order, 2026-11-16:
 * "cancel mini player by swipe left right"). The bar had NO
 * close affordance at all before this — the design draws none —
 * so dismissal is a gesture: drag the bar horizontally, either
 * direction, and past the threshold it slides off and ends the
 * playback session; short of the threshold it springs back.
 * Kept pure (no RN imports) so the decision is unit-testable;
 * MiniPlayer.tsx owns the gesture + animation wiring.
 */

/** Drag distance (px) past which a release dismisses the bar. */
export const MINI_PLAYER_DISMISS_DISTANCE = 110;

/** Flick velocity (px/s, either direction) that dismisses even
    a short drag. */
export const MINI_PLAYER_DISMISS_VELOCITY = 800;

/**
 * Should releasing the drag at this translation/velocity
 * dismiss the bar? Symmetric by design — the owner's words are
 * "swipe left right", both directions cancel.
 */
export function shouldDismissMiniPlayer(
  translationX: number,
  velocityX: number,
): boolean {
  return (
    Math.abs(translationX) >= MINI_PLAYER_DISMISS_DISTANCE ||
    Math.abs(velocityX) >= MINI_PLAYER_DISMISS_VELOCITY
  );
}

/**
 * The off-screen X a dismissed bar animates to: past the edge
 * it was dragged toward (a flick's direction wins over a tiny
 * opposing drag), with a margin so the card's shadow clears too.
 */
export function miniPlayerDismissTargetX(
  translationX: number,
  velocityX: number,
  viewportWidth: number,
): number {
  const direction =
    Math.abs(velocityX) >= MINI_PLAYER_DISMISS_VELOCITY
      ? Math.sign(velocityX)
      : Math.sign(translationX) || 1;
  return direction * (viewportWidth + 40);
}

/** The bar fades as it travels: fully opaque at rest, gone by
    the time it reaches the dismiss distance × 2. */
export function miniPlayerSwipeOpacity(translationX: number): number {
  const t = Math.min(
    1,
    Math.abs(translationX) / (MINI_PLAYER_DISMISS_DISTANCE * 2),
  );
  return 1 - t;
}
