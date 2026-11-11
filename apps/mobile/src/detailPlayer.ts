import type { PlaybackMode } from '@kaikansen/contracts';
import type { MediaCandidate } from './mediaEngine';

/**
 * Theme Detail player-backend split (perf problem 12) — the PURE
 * decision core of the split, kept free of native imports so
 * every rule here is unit-testable (the components in
 * src/components/DetailWatchHero.tsx / DetailListenHero.tsx /
 * DetailProgress.tsx are thin renderers over these decisions).
 *
 * The split itself:
 * - The Watch hero (expo-video surface + controls) and the Listen
 *   hero (expo-audio presentation) are SEPARATE components with
 *   separate mounts; only the ACTIVE mode's backend mounts. The
 *   engine/session lives in the provider (src/playback-context
 *   .tsx), never in a hero — so mounting/unmounting a hero can
 *   not restart the track or lose the position, and a mode
 *   switch is exactly the engine claim change it always was.
 * - Progress (seek fill, waveform played split, time labels)
 *   lives in the small progress components, fed by the provider's
 *   progress channel (usePlaybackProgress). The page body reads
 *   only the SLOW channel (usePlaybackSlowSession): its render
 *   inputs are the engine's memoised slow object, whose identity
 *   is stable across progress ticks (problem 8), so a tick can
 *   not re-render the page body. `splitPlaybackChannels` below
 *   is that channel derivation, in pure form for the tests.
 *
 * PER-MODE SURFACES (2026-11-11 restructure — regression-driven,
 * supersedes the same-day single-surface fix): each backend owns
 * its surface again, as in the pre-fix structure that worked in
 * the field (problem 12's original shape). The WATCH hero mounts
 * the watch surface: born visible, in-flow 16:9, never
 * hidden-styled, never restyled — it unmounts wholesale with the
 * backend. The LISTEN hero mounts its own hidden surface (1×1,
 * opacity 0) for the hidden-video fallback. The interim design —
 * ONE page-owned surface whose style flipped hidden↔visible —
 * shipped in 1.0.0/1.0.1 and the owner's field reports indict
 * it: 1.0.0 Watch was audio-only at 0:00; 1.0.1 rendered frames
 * for ~3s, then the player died into the audio fallback; the
 * owner confirms Watch worked before today's changes and audio
 * never broke. What makes per-mode surfaces safe THIS time is
 * the engine's surface discipline (usePlayback): a surface's
 * unmount pauses the player synchronously (surfaceDetach —
 * never playing while unbound), and a watch resume waits for
 * the NEW surface's first rendered frame through the
 * surface-readiness gate. The pure mount rule is
 * `detailSurfaceMount` below.
 */

/** Which hero the Theme Detail page mounts for a play mode. */
export type DetailBackend = 'watch' | 'listen' | 'artwork';

/**
 * The backend for the page's current play mode: 'watch' and
 * 'listen' mount their dedicated backend component; a null mode
 * (nothing claimed yet) mounts NO player backend — the plain
 * artwork hero the design shows before play.
 */
export function detailBackendForMode(
  playMode: PlaybackMode | null,
): DetailBackend {
  if (playMode === 'watch') return 'watch';
  if (playMode === 'listen') return 'listen';
  return 'artwork';
}

/**
 * The player backends mounted for a play mode — always ZERO or
 * ONE, never both: the inactive mode's backend is unmounted, not
 * hidden. (Before the split both backends sat mounted-but-hidden
 * in one component body.) Since the 2026-11-11 restructure the
 * backends DO carry their mode's surface (see the header): the
 * swap below is therefore also the surface swap, and it runs
 * under the engine's pause/detach/resume-gate discipline.
 */
export function mountedDetailBackends(
  playMode: PlaybackMode | null,
): readonly ('watch' | 'listen')[] {
  const backend = detailBackendForMode(playMode);
  return backend === 'artwork' ? [] : [backend];
}

/** Which surface form a backend mounts (2026-11-11 restructure). */
export type DetailSurfaceMount = 'watch-visible' | 'listen-hidden' | null;

/**
 * The surface mount rule: exactly ONE surface per mounted
 * backend, in that mode's own form — the watch surface born
 * visible (never hidden-styled, never restyled), the listen
 * surface born hidden for the fallback. The artwork state mounts
 * none: nothing is claimed, nothing plays (a pause-phase
 * preloaded video stays surfaceless until the tap, exactly as
 * pre-fix). W2 needs no special case: the watch backend STAYS
 * mounted through the degradation (it renders the artwork in
 * place of the video area with its surface hidden — the
 * pre-fix shape), so the surface set never changes mid-claim.
 */
export function detailSurfaceMount(
  backend: DetailBackend,
): DetailSurfaceMount {
  if (backend === 'watch') return 'watch-visible';
  if (backend === 'listen') return 'listen-hidden';
  return null;
}

/**
 * The hidden-video candidate of a listen chain — a VIDEO file
 * reached as an audio candidate (the UNTOUCHABLE fallback): the
 * listen claim must keep it playing through expo-video with NO
 * visible surface, sound only. The listen backend's OWN hidden
 * surface serves it (detailSurfaceMount 'listen-hidden'); this
 * helper names WHICH candidate it exists for, so the chain tests
 * can prove the candidate still resolves inside the listen chain
 * after the split. Null when the chain is pure audio (the
 * surface then binds an idle player, exactly as before the
 * split).
 */
export function hiddenVideoCandidate(
  candidates: readonly MediaCandidate[],
): MediaCandidate | null {
  return (
    candidates.find(
      (c) => c.kind === 'video' && c.role === 'hidden-video',
    ) ?? null
  );
}

/**
 * How many waveform bars the Listen hero paints as played for a
 * playback fraction — the played/unplayed split is the only real
 * data on the decorative waveform (see waveBarHeights on the
 * page). Rounds like the original inline computation, clamped
 * to the bar count.
 */
export function wavePlayedBars(fraction: number, barCount: number): number {
  if (!Number.isFinite(fraction) || barCount <= 0) return 0;
  const played = Math.round(fraction * barCount);
  return Math.min(barCount, Math.max(0, played));
}

/**
 * The seek ratio for a tap on a progress bar: the tap's x over
 * the bar's measured width. A bar that has not laid out yet
 * (width 0) yields null — no seek. The ratio itself is passed
 * through unclamped, exactly as before the split: the engine's
 * seekToRatio owns the clamping.
 */
export function seekRatioForTap(
  locationX: number,
  barWidth: number,
): number | null {
  if (barWidth <= 0) return null;
  return locationX / barWidth;
}

/** The progress channel's payload: the fast pair, nothing else. */
export interface DetailProgressChannel {
  progress: { current: number; duration: number };
  fraction: number;
}

/**
 * The channel split the provider performs (perf problem 12):
 * given the engine's return, the PAGE channel is the slow object
 * itself — passed by reference, never rebuilt — and the PROGRESS
 * channel is the progress pair alone. A progress tick therefore
 * produces a new progress channel while the page channel keeps
 * its identity, which is what stops a tick from re-rendering the
 * page body (React bails out on an unchanged context value /
 * memo prop). The generic slow type keeps this usable for any
 * slow object the engine memoises.
 */
export function splitPlaybackChannels<S>(
  slow: S,
  progress: { current: number; duration: number },
  fraction: number,
): { page: S; progressChannel: DetailProgressChannel } {
  return { page: slow, progressChannel: { progress, fraction } };
}
