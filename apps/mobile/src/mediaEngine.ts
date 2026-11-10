/**
 * Media engine routing + stall watchdog (playback plan,
 * 2026-11-10): the candidate chain is routed BY FILE TYPE within
 * the same chain — real audio files play through expo-audio,
 * video files play through expo-video — and a source stuck in
 * `loading` advances the chain exactly like a hard error does.
 * This module is the PURE half of that machinery: no native
 * imports, so every decision here is unit-testable (the hooks in
 * usePlayback.ts / QuizMedia.tsx feed it live snapshots; the
 * engines themselves stay thin adapters over the two players).
 */

/**
 * The stall watchdog budget (playback plan decision 4): a source
 * that stays in `loading` for this long without reaching playing
 * is treated as failed — the chain advances through the same
 * failure path a hard error takes. Shared by the detail/player
 * engine and every quiz surface.
 */
export const PLAYBACK_STALL_WATCHDOG_MS = 4000;

/**
 * Which native engine owns a candidate source. Audio extensions
 * route to expo-audio; everything else (extension-less or a video
 * extension) routes to expo-video. Local downloads keep their
 * file:// URIs — the extension test strips query/hash first, so
 * CDN URLs carrying signatures classify like their bare paths.
 */
export type MediaEngineKind = 'audio' | 'video';

const AUDIO_EXTENSIONS = [
  '.ogg',
  '.mp3',
  '.m4a',
  '.aac',
  '.opus',
  '.flac',
  '.wav',
  '.oga',
] as const;

export function mediaKindForUrl(url: string): MediaEngineKind {
  const path = url.split(/[?#]/)[0].toLowerCase();
  return AUDIO_EXTENSIONS.some((ext) => path.endsWith(ext))
    ? 'audio'
    : 'video';
}

/**
 * One candidate of a playback chain: where it lives, which
 * engine owns it, and the role it plays in the chain.
 *
 * Roles (the doctrine's vocabulary, unchanged by this plan):
 * - 'primary' — the chain's first candidate;
 * - 'audio-fallback' — a listen candidate beyond the first, in
 *   particular the W2 target (the .ogg) when a watch chain
 *   degrades to the listen chain;
 * - 'hidden-video' — a VIDEO file reached as an AUDIO candidate
 *   (the untouchable hidden-video fallback: played through
 *   expo-video with no visible surface, sound only).
 */
export interface MediaCandidate {
  url: string;
  kind: MediaEngineKind;
  role: 'primary' | 'audio-fallback' | 'hidden-video';
}

/**
 * Tag a chain of candidate URLs with their engine kind + role.
 *
 * `purpose` says what the chain is FOR:
 * - 'watch': every candidate is a video candidate (the watch
 *   chain); an audio file appearing here (defensive — the watch
 *   chain is built from video sources) still routes by file type,
 *   with the plain fallback role.
 * - 'listen': candidates are audio candidates in doctrine order;
 *   a VIDEO file in this chain is the hidden-video last resort —
 *   routed to expo-video, tagged so the surface keeps it hidden.
 * - 'chain' (the W2 degradation): the listen chain served in
 *   place of an exhausted watch chain; the first audio candidate
 *   is the audio-fallback target, and a video file is again the
 *   hidden-video last resort.
 */
export function tagCandidates(
  urls: readonly string[],
  purpose: 'watch' | 'listen' | 'chain',
): MediaCandidate[] {
  return urls.map((url, index) => {
    const kind = mediaKindForUrl(url);
    let role: MediaCandidate['role'] = index === 0 ? 'primary' : 'audio-fallback';
    if (kind === 'video' && purpose !== 'watch') {
      role = 'hidden-video';
    }
    return { url, kind, role };
  });
}

/**
 * The preload slot a surface keeps beside its live player
 * (playback plan: mode-matched preload on theme detail, the
 * quiz countdown preload, the solo next-question preload, and
 * the problem-3 queue next-track preload). One preload slot per
 * surface/engine family; `ready` flips when the source has
 * loaded far enough to start near-instantly on tap.
 */
export interface PreloadTicket {
  /** Identity of the intent (theme/entry/question key). */
  key: string;
  url: string;
  kind: MediaEngineKind;
  ready: boolean;
}

/** A fresh ticket for a preload that has not finished loading. */
export function createPreloadTicket(
  key: string,
  url: string,
): PreloadTicket {
  return { key, url, kind: mediaKindForUrl(url), ready: false };
}

/**
 * Whether a tap should CONSUME the preload (play from the
 * preloaded handle) rather than load fresh: the ticket must be
 * for the same intent key AND the same URL — a different entry
 * or a mode switch never reuses a stale preload.
 */
export function preloadMatches(
  ticket: PreloadTicket | null,
  key: string,
  url: string,
): boolean {
  return ticket !== null && ticket.key === key && ticket.url === url;
}

/**
 * The chain candidate a preload should target: the FIRST
 * audio-kind candidate (the doctrine's .ogg-first order means
 * it is normally candidate 0). Video candidates are never
 * preloaded by the audio preload path — a round/entry whose
 * first candidate is a video file keeps its expo-video hold
 * path instead (see `firstCandidateIsVideo`).
 */
export function pickPreloadCandidate(
  candidates: readonly MediaCandidate[],
): MediaCandidate | null {
  return candidates.find((c) => c.kind === 'audio') ?? null;
}

/** True when the chain leads with a video file (no .ogg ahead). */
export function firstCandidateIsVideo(
  candidates: readonly MediaCandidate[],
): boolean {
  return candidates.length > 0 && candidates[0].kind === 'video';
}

/* ------------------------------------------------------------------ */
/* Stall watchdog (pure decision core)                                 */
/* ------------------------------------------------------------------ */

/**
 * The watchdog snapshot the hooks build from their players each
 * status tick — deliberately tiny so the decision below stays a
 * pure function of it.
 *
 * - `loadingSince`: epoch ms when the current source entered
 *   `loading`; null when the player is not loading.
 * - `armedFrom`: epoch ms from which the watchdog may run —
 *   the intended start moment. On the multiplayer countdown the
 *   audio is intentionally HELD until the round's startedAt, so
 *   the countdown surfaces pass that moment here: a held load
 *   can never trip the watchdog before play was even meant to
 *   begin.
 * - `disabled`: a paused/idle consumer (or an engine with no
 *   source loaded) reports disabled and never trips.
 */
export interface WatchdogSnapshot {
  now: number;
  loadingSince: number | null;
  armedFrom: number;
  hasSource: boolean;
  failed: boolean;
  disabled: boolean;
}

/**
 * Should the chain advance NOW because the current source has
 * stalled? Trips only when ALL hold:
 * - a source is loaded and has not already failed;
 * - it has been in `loading` for at least the watchdog budget;
 * - the watchdog's arm moment is at least the budget in the
 *   past too (the countdown-hold guard: time spent intentionally
 *   held before the start moment never counts).
 */
export function watchdogShouldTrip(snap: WatchdogSnapshot): boolean {
  if (snap.disabled || snap.failed || !snap.hasSource) return false;
  if (snap.loadingSince === null) return false;
  if (snap.now - snap.loadingSince < PLAYBACK_STALL_WATCHDOG_MS) {
    return false;
  }
  if (snap.now - snap.armedFrom < PLAYBACK_STALL_WATCHDOG_MS) {
    return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Progress/state reference stability (problem 8)                      */
/* ------------------------------------------------------------------ */

/**
 * A progress pair worth rendering: positions arrive as floats
 * from the native players (2 ticks/sec at the current
 * timeUpdateEventInterval), and consumers label time to the
 * whole second — so progress is QUANTIZED to whole seconds
 * before it is stored. Two ticks inside the same second then
 * produce the SAME object, which is what stops the ~2×/sec tick
 * from invalidating memoised consumers: identical references
 * flow through the progress channel, and React's bail-out does
 * the rest. Duration lands on the same grid (players report it
 * in fractional seconds too).
 */
export function quantizeProgress(progress: {
  current: number;
  duration: number;
}): { current: number; duration: number } {
  const whole = (v: number): number =>
    Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
  return { current: whole(progress.current), duration: whole(progress.duration) };
}

/**
 * Keep the previous reference when the next progress is equal
 * after quantization — the setter pattern the engines use so a
 * same-second tick never produces a new state object at all.
 */
export function stabilizeProgress(
  prev: { current: number; duration: number },
  next: { current: number; duration: number },
): { current: number; duration: number } {
  const q = quantizeProgress(next);
  return q.current === prev.current && q.duration === prev.duration
    ? prev
    : q;
}

/** The seek fraction (0–1) for a progress pair — clamped, and 0
    while the duration is unknown. */
export function progressFraction(progress: {
  current: number;
  duration: number;
}): number {
  return progress.duration > 0
    ? Math.min(1, Math.max(0, progress.current / progress.duration))
    : 0;
}

/**
 * The same rule for the downloads store's per-download
 * fractions: the transfer callback already gates on whole
 * percents, and this keeps the store from emitting a fresh
 * progress map for a value it already holds (a percent tick
 * must not rebuild consumers of unrelated downloads).
 */
export function progressValueChanged(
  prev: number | null | undefined,
  next: number | null,
): boolean {
  return prev !== next;
}

/* ------------------------------------------------------------------ */
/* Stall-watchdog interval decision                                    */
/* ------------------------------------------------------------------ */

/**
 * The interval the engine hooks poll the watchdog with (500ms):
 * fine enough that a trip lands within ~0.5s of the budget, cheap
 * enough to run beside the progress ticks. The DECISION of
 * whether to even arm the poll lives here: only a live consumer
 * with a source loaded should run an interval at all; everyone
 * else (inactive, failed, source-less) leaves the timer asleep.
 */
export const WATCHDOG_POLL_INTERVAL_MS = 500;

export function watchdogPollActive(args: {
  active: boolean;
  hasSource: boolean;
  failed: boolean;
}): boolean {
  return args.active && args.hasSource && !args.failed;
}

/* ------------------------------------------------------------------ */
/* Problem 3 — queue next-track preload gating                         */
/* ------------------------------------------------------------------ */

/**
 * The problem-3 gate (owner rule, 2026-11-10): the NEXT queue
 * track's .ogg preloads ONLY once the current track is no
 * longer buffering — preload traffic must never compete with a
 * still-loading current track. "No longer buffering" is the
 * conjunction below: playback is actually running AND the
 * engine no longer reports buffering.
 */
export interface NextPreloadSnapshot {
  /** The current track is playing (not paused/buffering/ended). */
  isPlaying: boolean;
  /** The engine's buffering flag for the current track. */
  buffering: boolean;
  /** The next queue item, if any. */
  next: { slug: string; atEntryId: number | null } | null;
  /** The next item is already downloaded (offline needs none). */
  nextOffline: boolean;
}

export function shouldPreloadNext(snap: NextPreloadSnapshot): boolean {
  if (!snap.next) return false;
  if (snap.nextOffline) return false;
  return snap.isPlaying && !snap.buffering;
}

/**
 * The preload ticket key for a queue item — slug + entry, so a
 * skip or a version switch re-keys (and thereby discards) the
 * preload instead of serving a stale one.
 */
export function queuePreloadKey(item: {
  slug: string;
  atEntryId: number | null;
}): string {
  return `queue:${item.slug}:${item.atEntryId ?? 'first'}`;
}
