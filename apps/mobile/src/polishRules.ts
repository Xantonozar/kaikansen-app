/**
 * Polish batch seams (2026-11-11) — the pure decision rules the
 * six UX fixes hang on, kept out of the screens so they are
 * unit-tested directly instead of through JSX:
 *
 * - `downloadFillPercent`: the Downloads screen's determinate
 *   rule. A real fraction renders as its percentage; an
 *   indeterminate download (no fraction reported yet) renders
 *   NO fill — the old hardcoded fill claimed progress the app
 *   did not have (the label never lied; the bar did).
 * - `sectionStatus`: the User Profile satellite derivation. A
 *   section shows its failure row only when its fetch FAILED
 *   and no data has landed since (a later silent cache swap
 *   that delivers data clears the failure — the section reads
 *   normally again). Loading and loaded sections never show it.
 */

/**
 * The width percentage for a download's progress fill, or null
 * when the download is indeterminate — the caller then renders
 * the track with no fill at all.
 */
export function downloadFillPercent(
  progress: number | null | undefined,
): number | null {
  if (progress == null || !Number.isFinite(progress)) return null;
  return Math.round(Math.min(1, Math.max(0, progress)) * 100);
}

/** One satellite section's load posture on the User Profile. */
export type SectionLoadState = 'loading' | 'ready' | 'failed';

/**
 * Whether a profile satellite section renders its
 * "Couldn't load — Retry" row: only a settled failure with no
 * data. `failed` is the section's own failure flag; `hasData`
 * is whether the section currently holds a payload (cache
 * swaps included).
 */
export function sectionStatus(
  failed: boolean,
  hasData: boolean,
): SectionLoadState {
  if (hasData) return 'ready';
  return failed ? 'failed' : 'loading';
}
