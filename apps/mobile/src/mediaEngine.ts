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
 * failure path a hard error takes. As of the 2026-11-11 watch
 * fix this budget governs the QUIZ surfaces (whose countdown
 * arming is built on it); the detail/player engine uses the
 * kind-based grace + started-source immunity in the watch-fix
 * section below (stallShouldTrip).
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
/* Watch fix (2026-11-11) — failure attribution, single-load         */
/* decision, and the detail/player stall watchdog.                   */
/*                                                                   */
/* Diagnosis: WATCH-102-FAILURE-DIAGNOSIS.md (H1/H2). The QUIZ       */
/* engine keeps the watchdog above unchanged (its countdown-hold     */
/* arming depends on it); everything in this section is used ONLY    */
/* by the detail/player engine (usePlayback).                        */
/* ------------------------------------------------------------------ */

/**
 * The channels a source failure can be reported on. One physical
 * failure is typically reported TWICE — the load promise rejects
 * AND the player's status flips to 'error' — and the two reports
 * do not arrive atomically: the chain may already have advanced
 * when the second one lands.
 */
export type FailureChannel = 'promise' | 'status' | 'watchdog' | 'sync';

/**
 * May this failure report be HANDLED against the current
 * candidate? The rules that keep one failure from burning two
 * chain candidates (diagnosis §1.6/§6):
 *
 * - CURRENCY: a report naming a URL that is no longer the
 *   current load is stale and ignored (the promise channel's
 *   long-standing guard, generalised).
 * - PER-URL ATTRIBUTION: a URL whose failure was already handled
 *   can never be handled again, on any channel.
 * - STATUS-CHANNEL SUBORDINATION: the 'status' channel cannot
 *   name its source. While the current load's promise is still
 *   in flight, a status error is either that load's own (the
 *   promise rejection will handle it, correctly attributed) or
 *   a stale duplicate of the PREVIOUS candidate's failure — in
 *   both cases the promise channel owns it, so the status report
 *   is ignored. Once the current load has SETTLED (its promise
 *   resolved), a status error is a genuine post-load failure of
 *   the current source and is handled against it.
 */
export function failureAttributionDecision(args: {
  channel: FailureChannel;
  /** The URL this report is attributed to (the caller names the
      load it belongs to; the status channel names the current
      load, which the subordination rule then vets). */
  reportUrl: string | null;
  /** The URL loaded right now (loadedUrlRef). */
  currentUrl: string | null;
  /** Has the current load's promise resolved (settled)? */
  currentLoadSettled: boolean;
  /** URLs whose failure has already been handled. */
  handledUrls: ReadonlySet<string>;
}): 'handle' | 'ignore' {
  const { channel, reportUrl, currentUrl, handledUrls } = args;
  if (reportUrl === null || currentUrl === null) return 'ignore';
  if (reportUrl !== currentUrl) return 'ignore';
  if (handledUrls.has(reportUrl)) return 'ignore';
  if (channel === 'status' && !args.currentLoadSettled) return 'ignore';
  return 'handle';
}

/** Immutably record a URL's failure as handled. */
export function markFailureHandled(
  handledUrls: ReadonlySet<string>,
  url: string,
): ReadonlySet<string> {
  if (handledUrls.has(url)) return handledUrls;
  const next = new Set(handledUrls);
  next.add(url);
  return next;
}

/**
 * The single-load decision for the video player (diagnosis §1.3):
 * the engine tracks the ONE load it has issued into the player
 * (by the inactive preload or by an activation). When a claim
 * activates over a candidate, exactly one of:
 * - 'adopt' — that same URL is already loaded (settled): play
 *   from it; issuing another load would restart it from zero and
 *   interrupt it (the double-load defect);
 * - 'wait' — that same URL is still loading: its settle handler
 *   owns the play/failure; do not issue a duplicate;
 * - 'issue' — no load for this URL exists: load it now.
 */
export type VideoLoadAction = 'issue' | 'adopt' | 'wait';

export function videoLoadAction(args: {
  candidateUrl: string;
  /** The URL of the load last issued into the video player. */
  issuedUrl: string | null;
  /** Whether that issued load's promise has resolved. */
  issuedSettled: boolean;
}): VideoLoadAction {
  if (args.issuedUrl !== args.candidateUrl) return 'issue';
  return args.issuedSettled ? 'adopt' : 'wait';
}

/**
 * The detail/player stall grace, by engine kind (owner ruling
 * 2026-11-11 19:10, replacing the 4s budget for this engine):
 * a source that has never started may be declared dead only
 * after this long of CONTINUOUS no-progress silence. Users on
 * bad net stall longer than 4s without being dead.
 */
export const AUDIO_STALL_GRACE_MS = 30_000;
export const VIDEO_STALL_GRACE_MS = 60_000;

export function stallGraceMs(kind: MediaEngineKind): number {
  return kind === 'audio' ? AUDIO_STALL_GRACE_MS : VIDEO_STALL_GRACE_MS;
}

/**
 * The rebuilt stall decision for the detail/player engine. The
 * hook tracks the current continuous buffering EPISODE:
 * `stallSince` is stamped when buffering begins and re-stamped
 * by any progress (a status leaving 'loading', an advancing
 * progress tick, playing); it is null whenever the player is
 * not in a stall. Rules (owner rulings, 2026-11-11):
 * - a source that has STARTED (played, advanced past 0, or —
 *   video — rendered frames) is NEVER killed for buffering:
 *   mid-playback stalls are waited out; only real player errors
 *   advance the chain;
 * - a never-started source trips only after the full kind grace
 *   of continuous silence.
 */
export interface StallSnapshot {
  now: number;
  kind: MediaEngineKind;
  stallSince: number | null;
  hasStarted: boolean;
  hasSource: boolean;
  failed: boolean;
  disabled: boolean;
}

export function stallShouldTrip(snap: StallSnapshot): boolean {
  if (snap.disabled || snap.failed || !snap.hasSource) return false;
  if (snap.hasStarted) return false;
  if (snap.stallSince === null) return false;
  return snap.now - snap.stallSince >= stallGraceMs(snap.kind);
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

/* ------------------------------------------------------------------ */
/* Watch quality (fixed best — owner ruling 2026-11-11: NO switching) */
/* ------------------------------------------------------------------ */

/**
 * One offered quality: an entry video source, by its REAL
 * resolution value. The watch chain walks these best-first; the
 * hero's resolution chip names the rung ACTUALLY playing.
 */
export interface WatchQualityOption {
  url: string;
  resolution: number;
}

/**
 * The resolution of the source ACTUALLY playing: the engine's
 * active URL matched back to an offered source. A fallback URL
 * (entry / theme videoUrl) or a local download matches nothing —
 * the result is null and the chip is omitted, NEVER guessed from
 * the highest resolution the entry merely offers (the batch-2
 * rule the Player chip already lives by).
 */
export function playingResolution(
  sources: readonly WatchQualityOption[],
  activeUrl: string | null,
): number | null {
  if (activeUrl === null) return null;
  return sources.find((s) => s.url === activeUrl)?.resolution ?? null;
}

/**
 * The surface-readiness gate (2026-11-11 video fix — the owner's
 * field report on the 1.0.1 build: Watch rendered real frames
 * for ~3s, then fell to the audio fallback). Root cause: the
 * engine called play() on a video player before any VideoView
 * surface had attached/rendered — expo-video on Android can lose
 * the player's video pipeline when playback starts surfaceless
 * (expo/expo#35012 family): frames flash briefly, the player
 * errors, and the chain falls back. The gate holds every WATCH
 * play until the bound surface signals its first rendered frame
 * (VideoView's onFirstFrameRender).
 *
 * This is the pure decision seam; the engine wires it to refs.
 *
 * - `watchSurfaceGateDecision` answers one question — may this
 *   play request reach the video player NOW?
 *   · only a 'primary' VIDEO candidate is gated: it is the one
 *     meant for the visible watch surface. Every VIDEO
 *     candidate with another role plays sound-only through the
 *     hidden surface (the listen chain's video files, incl. the
 *     'hidden-video' last resort — UNTOUCHABLE) and bypasses
 *     unconditionally.
 *   · a surface already ready for the CURRENT player instance
 *     plays immediately.
 *   · anything else HOLDS — the request is remembered by the
 *     engine and released the moment readiness fires.
 * - `surfaceReadinessAfterSwap`: readiness is PER PLAYER
 *   INSTANCE. A surface-player identity change (the pool reset
 *   on a claim change, unmount) forgets the old instance's
 *   readiness — the new instance must render its own first frame
 *   before a watch play reaches it.
 * - The gate never replaces the stall watchdog: a held play
 *   keeps the engine in `loading`, so a surface that never
 *   signals fails through the existing watchdog → chain path.
 */
export type SurfaceGateDecision = 'play' | 'hold';

export function watchSurfaceGateDecision(args: {
  /** The candidate's kind: audio-engine candidates never reach
      the video player, so the gate question does not arise. */
  kind: 'audio' | 'video';
  /** The candidate's role: a VIDEO candidate with any role but
      'primary' plays sound-only (the listen chain's video files,
      incl. the 'hidden-video' last resort) and is NEVER gated;
      only a 'primary' VIDEO candidate is meant for the visible
      watch surface. */
  role: 'primary' | 'audio-fallback' | 'hidden-video';
  /** Has the bound surface rendered a frame for THIS player? */
  surfaceReady: boolean;
  /** Watch fix (2026-11-11, diagnosis H2/§6.4): the player
      itself reports 'readyToPlay' for the current source — the
      source is loaded and playable, which is the same safety
      the first frame was proxying for. A held play releases on
      EITHER signal. Optional; omitting it keeps the original
      first-frame-only behaviour (the engine passes it only for
      fresh load/adopt/retry plays — a post-detach RESUME still
      waits for the new surface's own first frame, preserving
      the detach discipline). */
  playerReadyToPlay?: boolean;
}): SurfaceGateDecision {
  if (args.kind !== 'video' || args.role !== 'primary') return 'play';
  return args.surfaceReady || args.playerReadyToPlay ? 'play' : 'hold';
}

export function surfaceReadinessAfterSwap(args: {
  previousPlayerKey: string | null;
  nextPlayerKey: string | null;
  readyPlayerKey: string | null;
}): { ready: boolean; readyPlayerKey: string | null } {
  if (args.nextPlayerKey === null) {
    return { ready: false, readyPlayerKey: null };
  }
  if (args.nextPlayerKey !== args.previousPlayerKey) {
    // A different instance owns the surface now: only readiness
    // recorded FOR that instance counts.
    return {
      ready: args.readyPlayerKey === args.nextPlayerKey,
      readyPlayerKey: args.readyPlayerKey,
    };
  }
  return {
    ready: args.readyPlayerKey === args.nextPlayerKey,
    readyPlayerKey: args.readyPlayerKey,
  };
}

/**
 * The artwork-under-player rule (perf problem 7): while a watch
 * surface has NOT rendered video frames for the CURRENT source —
 * before the first frame, and during a quality switch until the
 * new source renders — the anime artwork shows under/behind the
 * video surface instead of a black rectangle. The moment frames
 * render, the video fully covers it. Listen mode never reaches
 * this rule (its own artwork presentation is separate), and a
 * source with no artwork leaves the plain black surface.
 *
 * - `framesRendered`: frames for the CURRENT source are on
 *   screen (the engine keys this per source; any source change
 *   resets it — a switch is a new source).
 */
export function watchArtworkUnderPlayer(args: {
  hasArtwork: boolean;
  framesRendered: boolean;
}): boolean {
  return args.hasArtwork && !args.framesRendered;
}
