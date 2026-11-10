import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  createVideoPlayer,
  useVideoPlayer,
  type VideoPlayer,
} from 'expo-video';
import { useEvent, useEventListener } from 'expo';
import type {
  PlaybackMode,
  ThemeDetail,
  ThemeEntry,
} from '@kaikansen/contracts';
import { recordWatch } from './api';
import { markOwnProfileStatsDirty } from './profileStatsCache';
import {
  adoptPreloadedPlayer,
  discardPreload,
  ensureAudioMode,
  preloadAudio,
  releaseAudioPlayer,
  useAudioPlayer,
  useAudioPlayerStatus,
  type AudioPlayer,
  type AudioStatus,
} from './audioEngine';
import { downloadFileUri, useDownloads, type DownloadRecord } from './downloads';
import {
  WATCHDOG_POLL_INTERVAL_MS,
  mediaKindForUrl,
  planQualitySwitch,
  progressFraction,
  queuePreloadKey,
  shouldPreloadNext,
  stabilizeProgress,
  tagCandidates,
  watchdogPollActive,
  watchdogShouldTrip,
  type MediaCandidate,
  type QualitySwitchPlan,
} from './mediaEngine';
import {
  isPlausibleUrl,
  resolveListenCandidates,
  resolvePlaybackUrl,
  resolveWatchCandidates,
} from './playback';

/**
 * Playback engine (extracted from the player route, Slice M1;
 * playback plan rework 2026-11-10) — the app's ONE playback
 * engine, shared by the player route (Library / playlist opens)
 * and the theme detail screen's INLINE player (the website and
 * the design play on the theme page itself; the detail screen no
 * longer navigates away to play).
 *
 * TWO native players now sit behind the engine, and the
 * candidate chain is routed BY FILE TYPE within the chain
 * (the owner's playback plan): real audio files — the derived
 * .ogg, a genuine stored audio file, a downloaded audio file —
 * play through expo-audio; video files play through expo-video —
 * Watch, and the hidden-video listen fallback (a VIDEO file
 * reached as an audio candidate: played through expo-video with
 * NO visible surface, sound only — UNTOUCHABLE, exactly as
 * before). The doctrine order is unchanged: derived .ogg →
 * genuine stored audio → the video file picture-hidden.
 *
 * Behaviour, identical for both consumers:
 *
 * - The SELECTED ENTRY is the source of truth (src/playback.ts):
 *   watch = the entry's video sources by resolution descending →
 *   entry videoUrl → theme videoUrl; listen = stored audio →
 *   the derived .ogg twin of the video file → the video file itself
 *   behind the artwork. Both modes advance one candidate per
 *   player error (a local download stays on its single file).
 * - Offline first: a completed download for the entry+mode wins over
 *   the remote URL (the record is returned as `localUsable` so a
 *   consumer can render from its snapshot when the catalogue fetch
 *   failed).
 * - `active` gates loading: while false nothing is loaded or played.
 *   The detail screen keeps it false until the user presses
 *   Watch/Listen; flipping back to false pauses and unloads, so a
 *   slug change starts clean. The player route passes true.
 * - Watch degradation (W2, opt-in via `watchAudioFallback` — the
 *   theme detail claim): when the watch chain exhausts (every
 *   video candidate failed, or there were none), playback falls
 *   back to the listen chain's audio — the .ogg first — instead of
 *   surfacing the error, and the hook reports `audioFallback` so
 *   the consumer can show the artwork with an audio-only note.
 *   The session's mode stays 'watch' throughout: the toggle is
 *   the user's, and `retry` disengages the fallback to try the
 *   video again. Only when the audio chain also exhausts does
 *   the error surface.
 * - History: the first time playback genuinely starts for an
 *   entry+mode, POST /library/history fires once (recordWatch no-ops
 *   in fixture mode and when signed out). Resumes/seeks never
 *   re-fire; a different entry or mode records again.
 * - Leaving/unmounting pauses the players (the hook releases
 *   them), so no audio leaks over other screens. Background
 *   playback and PiP stay deliberately off (the expo-audio mode
 *   in src/audioEngine.ts disables background too).
 *
 * Playback-plan additions (2026-11-10):
 *
 * - MODE-MATCHED PRELOAD (detail claims pass `preload`): while
 *   the session is INACTIVE the engine preloads the mode's media
 *   without playing — Listen preloads the whole .ogg through the
 *   audio preload slot (src/audioEngine.ts); Watch preloads the
 *   video into the (paused) video player. A tap then ADOPTS the
 *   preloaded player/source (no re-create, no re-download) and
 *   starts near-instantly. A preload is keyed by slug+entry+mode;
 *   switching the mode or entry re-keys and discards it.
 * - STALL WATCHDOG (~4s, PLAYBACK_STALL_WATCHDOG_MS): a source
 *   stuck in `loading` advances the chain through the SAME
 *   failure path a hard error takes (see src/mediaEngine.ts).
 * - PROBLEM 3 (queue next-track preload): while a queue track
 *   plays, the provider passes the NEXT queue item's resolved
 *   listen chain as `nextPreload`; the engine preloads its .ogg
 *   through the slot ONLY once the current track is no longer
 *   buffering (stable playing — src/mediaEngine.ts
 *   shouldPreloadNext), one track ahead; a skip or queue change
 *   re-keys and replaces it, and the eventual advance adopts it
 *   when the claim key matches. Offline next tracks need none
 *   (the provider passes nothing for them).
 * - PROBLEM 8 (progress split): progress lives in its own state,
 *   QUANTIZED to whole seconds and reference-stabilised
 *   (stabilizeProgress) — same-second ticks produce no state
 *   change at all, and the hook's return value is split into a
 *   memoised slow object (everything but progress/fraction) and
 *   the progress pair, so the ~2 ticks/sec only re-render the
 *   components that read progress. The active engine is exposed
 *   as `player` (the video player for video candidates, the
 *   audio player for audio candidates) with two additive
 *   affordances for consumers: `surfacePlayer` (always the video
 *   player — the only player a VideoView can bind) and
 *   `surfaceKind` (which engine the current candidate plays on).
 * - PROBLEM 12 (theme detail split): the return also carries the
 *   slow object itself as `slow` (see the PlaybackSlow type), so
 *   the provider can hand page bodies a channel whose identity
 *   never changes on a progress tick, while the tick pair rides
 *   its own channel (usePlaybackProgress in playback-context).
 *
 * Perf problem 7 (watch quality, 2026-11-10):
 *
 * - `switchQuality(url)` performs a CONTROLLED CANDIDATE JUMP
 *   inside the existing watch chain (planQualitySwitch in
 *   mediaEngine.ts): the picked source becomes the chain's
 *   current candidate and a failure there keeps walking FORWARD
 *   through the same handleFailure path (then W2, as usual). The
 *   position + playing state captured at pick time are restored
 *   when the swapped source's load settles — a native replace
 *   starts at 0, so the restore rides the load promise's
 *   resolution (and only there: no position polling). The load
 *   re-stamps the stall watchdog's arm moment, so a switch that
 *   stalls advances the chain exactly like a stalled start.
 * - `framesRendered` tracks whether the video engine has
 *   rendered frames for the CURRENT source (status readyToPlay
 *   or playing); any source change resets it, so surfaces can
 *   hold the anime artwork UNDER the player until the new
 *   source's frames land (a quality switch included), instead
 *   of flashing black.
 * - `surfacePlayer` SWAPS to a second lazily-created video
 *   player while a quality switch is in flight: the old player
 *   keeps its last frame on screen during the load, and the new
 *   player becomes the surface only once ITS frames render —
 *   the surface never binds a player whose replace would blank
 *   it mid-switch. Outside switches this is exactly the primary
 *   player, as before.
 */

export interface PlaybackPreloadRequest {
  /** Identity of the intent (theme detail: slug+entry+mode). */
  key: string;
  mode: PlaybackMode;
  /** The mode's candidate URLs in doctrine order. */
  candidates: string[];
}

export interface NextTrackPreload {
  /** Identity of the intent (provider: queuePreloadKey). */
  key: string;
  /** The next item's listen chain, doctrine order (.ogg first). */
  candidates: string[];
  /** Skip entirely (the next item is already downloaded). */
  offline: boolean;
}

/** The audio engine's status, normalised for the event bridge. */
type AudioStatusEvent = AudioStatus & { isBuffering?: boolean };

/** A player-agnostic control handle over the ACTIVE engine. */
export interface ActivePlayerHandle {
  currentTime: number;
  play: () => void;
  pause: () => void;
  replay: () => void;
}

/**
 * A second expo-video player handle, created lazily by the
 * VIDEO POOL (see usePlayback) the first time a quality switch
 * needs somewhere to load the picked source while the current
 * surface keeps showing the old player's last frame. It mirrors
 * the small slice of the VideoPlayer surface the engine drives;
 * the real player satisfies it structurally.
 */
export interface SwitchPlayerHandle {
  status: VideoPlayer['status'];
  playing: boolean;
  duration: number;
  currentTime: number;
  replaceAsync: (source: string | null) => Promise<void>;
  play: () => void;
  pause: () => void;
  replay: () => void;
  addListener: VideoPlayer['addListener'];
}

export function usePlayback(args: {
  slug: string | null;
  detail: ThemeDetail | null;
  entry: ThemeEntry | null;
  /** Download lookup key when it differs from the resolved entry
      (the player route's explicit entry param). */
  entryIdOverride?: number | null;
  mode: PlaybackMode;
  active: boolean;
  /** Opt-in (theme detail claims it): degrade an exhausted watch
      chain to the listen chain's audio instead of the error state
      (see the header's W2 note). Off for every other consumer. */
  watchAudioFallback?: boolean;
  /** Mode-matched preload while the session is INACTIVE (theme
      detail claims it from its open mode). Null = no preload. */
  preload?: PlaybackPreloadRequest | null;
  /** Adoption identity override: the provider's queue claims set
      the session's preloadKey to the QUEUE item's key (problem 3 —
      the engine preloaded under that key while the previous track
      played); the engine adopts a slot preload whose key matches
      EITHER this or its derived slug+entry+mode claim key. */
  claimPreloadKey?: string | null;
  /** Problem 3: the next queue item's listen chain, preloaded
      once the current track is stably playing. Null = none. */
  nextPreload?: NextTrackPreload | null;
  /** Perf problem 7: factory for the lazily-created SECOND video
      player a quality switch loads into (see the header's
      surface-swap note). Tests inject a fake; production omits it
      and the engine builds a real player through expo-video's
      createVideoPlayer on first use. */
  createSwitchPlayer?: (source: string) => SwitchPlayerHandle;
}) {
  const { slug, detail, entry, mode, active } = args;
  const watchAudioFallback = args.watchAudioFallback === true;
  const preloadRequest = args.preload ?? null;
  const nextPreload = args.nextPreload ?? null;
  const claimPreloadKey = args.claimPreloadKey ?? null;
  const downloads = useDownloads();

  const wantedEntryId =
    args.entryIdOverride != null ? args.entryIdOverride : entry?.atEntryId;
  const localRecord =
    slug !== null && wantedEntryId != null
      ? downloads.find(slug, wantedEntryId, mode)
      : undefined;
  const localUsable: DownloadRecord | undefined =
    localRecord && !localRecord.fileMissing ? localRecord : undefined;

  const rawUrl = detail ? resolvePlaybackUrl(detail, entry, mode) : null;
  const remoteUrl = isPlausibleUrl(rawUrl) ? rawUrl : null;

  // Fallback chains (playback.ts): listen = stored audio → derived
  // .ogg → the video file behind the artwork; watch = the entry's
  // video sources by resolution descending → entry videoUrl →
  // theme videoUrl. A local download stays on its single file; the
  // chains only engage for remote playback, advancing one step per
  // player error. The listen chain is resolved in watch mode too:
  // it is the W2 degradation target when the watch chain exhausts.
  const listenCandidates = useMemo(
    () => (detail ? resolveListenCandidates(detail, entry) : []),
    [detail, entry],
  );
  const watchCandidates = useMemo(
    () =>
      detail && mode === 'watch' ? resolveWatchCandidates(detail, entry) : [],
    [detail, entry, mode],
  );
  // W2 state: true once an exhausted watch chain has degraded to
  // the listen chain's audio (opt-in claims only).
  const [audioFallback, setAudioFallback] = useState(false);
  const candidates = audioFallback
    ? listenCandidates
    : mode === 'listen'
      ? listenCandidates
      : watchCandidates;
  const [candidateIndex, setCandidateIndex] = useState(0);
  // The URL whose failure was already handled (advanced past or
  // surfaced) — a failing source reports through BOTH the load
  // promise and the status listener; this keeps one failure from
  // advancing the chain twice.
  const failedUrlRef = useRef<string | null>(null);
  // A different theme/entry/mode restarts the chain from the top.
  useEffect(() => {
    setCandidateIndex(0);
    setAudioFallback(false);
    failedUrlRef.current = null;
  }, [slug, mode, entry?.atEntryId]);

  // W2, the empty-chain case: watch was claimed but the entry has
  // NO video candidates at all — the chain is exhausted before it
  // starts, so degrade to the audio chain immediately instead of
  // sitting on a dead "unavailable" (remote playback only; a local
  // watch download keeps its single-file behaviour).
  useEffect(() => {
    if (
      active &&
      mode === 'watch' &&
      watchAudioFallback &&
      !audioFallback &&
      !localUsable &&
      detail &&
      watchCandidates.length === 0 &&
      listenCandidates.length > 0
    ) {
      setAudioFallback(true);
    }
  }, [
    active,
    mode,
    watchAudioFallback,
    audioFallback,
    localUsable,
    detail,
    watchCandidates,
    listenCandidates,
  ]);

  const url = localUsable
    ? downloadFileUri(localUsable)
    : detail
      ? (candidates[candidateIndex] ?? null)
      : remoteUrl;
  const offline = localUsable !== undefined;
  // The current candidate, tagged with its engine + role. Local
  // downloads classify by their file's extension — a downloaded
  // audio file plays on the audio engine, a downloaded video on
  // the video engine (watch surfaces it; listen keeps it hidden).
  const chainPurpose: 'watch' | 'listen' | 'chain' = audioFallback
    ? 'chain'
    : mode;
  const candidate: MediaCandidate | null = url
    ? localUsable
      ? {
          url,
          kind: mediaKindForUrl(url),
          role:
            mediaKindForUrl(url) === 'video' && mode === 'listen'
              ? 'hidden-video'
              : 'primary',
        }
      : (tagCandidates(candidates, chainPurpose)[candidateIndex] ?? null)
    : null;
  const kind: 'audio' | 'video' = candidate?.kind ?? 'video';

  /* ---------------- the two native players ---------------- */
  const videoPlayer = useVideoPlayer(null, (p) => {
    p.timeUpdateEventInterval = 0.5;
    p.loop = false;
  });
  const hookAudioPlayer = useAudioPlayer(null, {
    updateInterval: 500,
    downloadFirst: false,
  });
  // The audio player actually driving playback: the hook's own
  // player, or one ADOPTED from the preload slot (a detail tap /
  // a queue advance consuming its preload). Adopted players are
  // released when playback moves off them.
  const [audioPlayerState, setAudioPlayerState] = useState<AudioPlayer>(
    hookAudioPlayer,
  );
  const audioPlayerRef = useRef<AudioPlayer>(hookAudioPlayer);
  const adoptedRef = useRef<AudioPlayer | null>(null);

  // The adoption identity: slug+entry+mode — the same key the
  // detail screen keys its preload with, so a tap adopts exactly
  // the preload that was made for this claim.
  const claimKey =
    slug !== null && wantedEntryId != null
      ? `${slug}:${wantedEntryId}:${mode}`
      : null;

  const audioStatus = useAudioPlayerStatus(audioPlayerState);
  const audioStatusRef = useRef<AudioStatusEvent>(audioStatus);
  audioStatusRef.current = audioStatus;
  // Bridge: useAudioPlayerStatus subscribes through useEvent,
  // whose listener identity is the FIRST render's — when the
  // adopted player replaces the hook's, status events from the
  // live player reach the engine through this ref-fed listener
  // instead (registered imperatively, refreshed per player).
  const [audioEventTick, setAudioEventTick] = useState(0);
  useEffect(() => {
    const player = audioPlayerState;
    let subscription: { remove: () => void } | null = null;
    try {
      subscription = player.addListener(
        'playbackStatusUpdate',
        (status: AudioStatus) => {
          audioStatusRef.current = status;
          setAudioEventTick((t) => t + 1);
        },
      );
    } catch {
      // Listener unsupported — the hook status channel stands.
    }
    return () => {
      try {
        subscription?.remove();
      } catch {
        // Already detached.
      }
    };
  }, [audioPlayerState]);

  const { status: videoStatus } = useEvent(videoPlayer, 'statusChange', {
    status: videoPlayer.status,
  });
  const { isPlaying: videoIsPlaying } = useEvent(
    videoPlayer,
    'playingChange',
    { isPlaying: videoPlayer.playing },
  );

  /* ---------------- perf problem 7: the video pool ----------------
     A quality switch loads the picked source into a SECOND video
     player so the visible surface can keep showing the current
     player's last frame until the new source renders — swapping
     the surface to a player mid-replace would blank it (its view
     drops the old frame the moment the new source starts
     loading). `switchPlayerState` is null until the first switch
     creates the player (lazily, through the injected factory or
     expo-video's createVideoPlayer); afterwards the two players
     alternate roles — the standby becomes the surface on a
     completed switch, and the retired one becomes the next
     standby. `standbyBusyRef` marks a switch in flight: while it
     is set, the standby's events are routed by the switch
     handlers below, never by the main engine's listeners. */
  const createSwitchPlayerRef = useRef(args.createSwitchPlayer);
  createSwitchPlayerRef.current = args.createSwitchPlayer;
  const [switchPlayerState, setSwitchPlayerState] =
    useState<SwitchPlayerHandle | null>(null);
  const switchPlayerRef = useRef<SwitchPlayerHandle | null>(null);
  const standbyBusyRef = useRef(false);
  // Status snapshots of the standby, fed by its own imperative
  // listeners (its events must not ride the primary's useEvent
  // channels — those are bound to the primary player object).
  const [standbyStatus, setStandbyStatus] = useState<
    'idle' | 'loading' | 'readyToPlay' | 'error'
  >('idle');
  const [standbyPlaying, setStandbyPlaying] = useState(false);
  const [standbyTick, setStandbyTick] = useState(0);
  const surfaceSwapped = switchPlayerState !== null;
  const surfaceSwappedRef = useRef(false);
  surfaceSwappedRef.current = surfaceSwapped;
  // Typed as the real VideoPlayer so VideoView binds it: the
  // production standby IS a real player (createVideoPlayer) —
  // the SwitchPlayerHandle seam exists only for the test fake.
  const surfacePlayer: VideoPlayer =
    (switchPlayerState as VideoPlayer | null) ?? videoPlayer;
  const surfaceStatus = surfaceSwapped ? standbyStatus : videoStatus;
  const surfaceIsPlaying = surfaceSwapped
    ? standbyPlaying
    : videoIsPlaying;

  /* ---------------- engine state (the slow channel) ---------------- */
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);
  // Progress is the FAST channel (problem 8): its own state,
  // whole-second quantized + reference-stabilised in the tick
  // handlers below, so same-second ticks change nothing at all.
  const [progress, setProgress] = useState({ current: 0, duration: 0 });

  const activeStatus: 'idle' | 'loading' | 'readyToPlay' | 'error' =
    playerError
      ? 'error'
      : !candidate
        ? 'idle'
        : kind === 'audio'
          ? audioStatus.error
            ? 'error'
            : audioStatus.isLoaded
              ? 'readyToPlay'
              : 'loading'
          : surfaceStatus;
  const isPlaying =
    kind === 'audio' ? audioStatus.playing : surfaceIsPlaying;
  const buffering =
    url !== null && activeStatus === 'loading' && !playerError;
  /* Perf problem 7 — frames on screen for the CURRENT source?
     expo-video exposes no first-frame event, so "rendered" is
     derived: the video engine reached readyToPlay (or is
     playing) for this source. Keyed by URL: any source change
     (a chain advance, a quality jump, a new claim) resets it via
     the effect below, and the artwork-under-player rule
     (mediaEngine.watchArtworkUnderPlayer) holds the poster
     under the surface until it flips back. The audio engine has
     no surface to cover — always "rendered". */
  const [renderedUrl, setRenderedUrl] = useState<string | null>(null);
  useEffect(() => {
    if (kind !== 'video' || !url) return;
    if (surfaceStatus === 'readyToPlay' || surfaceIsPlaying) {
      setRenderedUrl((prev) => (prev === url ? prev : url));
    }
  }, [kind, url, surfaceStatus, surfaceIsPlaying]);
  const framesRendered =
    kind !== 'video' ? true : url !== null && renderedUrl === url;
  const fraction = progressFraction(progress);

  const loadedUrlRef = useRef<string | null>(null);
  const loadedEngineRef = useRef<'audio' | 'video' | null>(null);
  /* Perf problem 7 — a quality switch in flight: the plan
     (target candidate + the position/playing state to restore),
     the candidate index the switch STARTED from (a failed switch
     load continues the chain from the PICK, per planQualitySwitch
     — this is only the watchdog's re-arm reference), and the
     generation counter that retires stale switch completions
     (a newer load/claim supersedes an in-flight switch). */
  const qualitySwitchRef = useRef<{
    plan: QualitySwitchPlan;
    generation: number;
  } | null>(null);
  const switchGenerationRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /**
   * One source failure: hand over to the next chain candidate, or —
   * on the last candidate (or a local file) — surface the error
   * state. A failure is reported through BOTH the load promise's
   * rejection and the player's status 'error'; failedUrlRef makes
   * sure each failing source is handled exactly once. (Load
   * rejections used to be swallowed entirely, which let a failed
   * watch source sit on a silent black surface — no frames, no
   * error, no retry.)
   */
  const handleFailureRef = useRef<(message?: string) => void>(() => {});
  handleFailureRef.current = (message?: string) => {
    const failedUrl = loadedUrlRef.current;
    if (failedUrl !== null) {
      if (failedUrlRef.current === failedUrl) return;
      failedUrlRef.current = failedUrl;
    }
    // A quality switch in flight is settled by ANY chain move:
    // the switch's own load failed over to here (the chain walks
    // forward from the pick and the standby's half-load is
    // abandoned), or a different failure superseded the switch.
    // Either way the standby goes back to idle and the surface
    // stays on the primary player.
    if (qualitySwitchRef.current) {
      qualitySwitchRef.current = null;
      switchGenerationRef.current += 1;
      standbyBusyRef.current = false;
      setSwitchLoading(false);
      try {
        switchPlayerRef.current?.pause();
      } catch {
        // Already released — nothing to stop.
      }
    }
    if (!localUsable && candidateIndex + 1 < candidates.length) {
      setCandidateIndex(candidateIndex + 1);
      return;
    }
    if (
      !localUsable &&
      mode === 'watch' &&
      watchAudioFallback &&
      !audioFallback &&
      listenCandidates.length > 0
    ) {
      // W2: the watch chain is exhausted — degrade to the listen
      // chain (the .ogg first) rather than a dead error. The
      // failed-URL guard resets so the audio chain's own failures
      // are handled fresh; the consumer renders the artwork and
      // the audio-only note off `audioFallback`.
      failedUrlRef.current = null;
      setCandidateIndex(0);
      setAudioFallback(true);
      return;
    }
    setPlayerError(
      message ??
        'This source could not be played. It may be unavailable or in a format this device cannot play.',
    );
  };
  const handleFailure = useCallback((message?: string) => {
    handleFailureRef.current(message);
  }, []);

  /* ---------------- per-engine load machinery ---------------- */
  // Video: loaded through replaceAsync; its promise rejection and
  // its statusChange 'error' both feed handleFailure (deduped).
  useEffect(() => {
    if (!active || !candidate || candidate.kind !== 'video') return;
    if (loadedUrlRef.current === candidate.url) return;
    // A quality switch owns the picked candidate's load (the
    // standby player is fetching it): the main effect stands
    // down for exactly that candidate until the switch settles.
    if (
      qualitySwitchRef.current &&
      candidates[qualitySwitchRef.current.plan.targetIndex] ===
        candidate.url
    ) {
      return;
    }
    loadedUrlRef.current = candidate.url;
    loadedEngineRef.current = 'video';
    setPlayerError(null);
    setEnded(false);
    setProgress({ current: 0, duration: 0 });
    void videoPlayer
      .replaceAsync(candidate.url)
      .then(() => {
        if (mountedRef.current) videoPlayer.play();
      })
      .catch((e: unknown) => {
        // A superseded load (a newer source already took over)
        // must not fail the source that replaced it.
        if (!mountedRef.current || loadedUrlRef.current !== candidate.url) {
          return;
        }
        handleFailureRef.current(
          e instanceof Error ? e.message : undefined,
        );
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, candidate?.url, candidate?.kind, videoPlayer]);

  // Pause the video engine the moment an audio candidate takes
  // over (and on deactivation below): no video sound may leak
  // under the audio chain.
  useEffect(() => {
    if (kind === 'video' && active) return;
    try {
      videoPlayer.pause();
    } catch {
      // Player already released — nothing to stop.
    }
  }, [kind, active, videoPlayer]);

  /* ---------------- perf problem 7: quality switch ----------------
     switchQuality(targetUrl) = a controlled candidate jump
     (planQualitySwitch): the picked source becomes the chain's
     current candidate, loaded into the STANDBY video player —
     the surface keeps the current player's frame until the new
     source renders, then surfacePlayer swaps to the standby and
     the retired player becomes the next standby. The position +
     playing state captured at pick time are restored when the
     standby's load settles (the .then below — the ONLY restore
     trigger; no position polling). The load re-stamps the
     watchdog's arm moment, so a switch that stalls advances the
     chain from the pick via handleFailure, exactly like a
     stalled start; a switch load that errors outright takes the
     same path. While a switch is in flight the main video load
     effect stands down for the picked candidate (guard above). */
  const ensureSwitchPlayer = useCallback(
    (source: string): SwitchPlayerHandle => {
      const existing = switchPlayerRef.current;
      if (existing) return existing;
      const factory = createSwitchPlayerRef.current;
      const created: SwitchPlayerHandle = factory
        ? factory(source)
        : (() => {
            // createVideoPlayer takes no setup callback (that is
            // useVideoPlayer's shape) — configure after creation.
            // A manually created player is never auto-released by
            // a hook; the pool keeps exactly one standby for the
            // engine's life, alternating roles with the primary.
            const real = createVideoPlayer(source);
            real.timeUpdateEventInterval = 0.5;
            real.loop = false;
            return real;
          })();
      switchPlayerRef.current = created;
      // The standby's own event channels (the primary's useEvent
      // hooks are bound to the primary player object): status +
      // playing feed the surface snapshots once this player IS
      // the surface; progress + playToEnd feed the engine while
      // it is the loaded engine. All three listeners stay for the
      // player's life; the busy flag routes their meaning.
      try {
        created.addListener('statusChange', ({ status: next, error }) => {
          if (switchPlayerRef.current !== created) return;
          if (standbyBusyRef.current) {
            // A switch load erroring: the chain advances from
            // the pick (handled there — never twice).
            if (next === 'error') {
              handleFailureRef.current(error?.message);
            }
            return;
          }
          setStandbyStatus(next);
          if (next === 'error' && loadedEngineRef.current === 'video') {
            handleFailureRef.current(error?.message);
          }
        });
        created.addListener('playingChange', ({ isPlaying: next }) => {
          if (switchPlayerRef.current !== created) return;
          if (!standbyBusyRef.current) setStandbyPlaying(next);
        });
        created.addListener('timeUpdate', ({ currentTime }) => {
          if (switchPlayerRef.current !== created) return;
          if (standbyBusyRef.current) return;
          if (loadedEngineRef.current !== 'video') return;
          setProgress((prev) =>
            stabilizeProgress(prev, {
              current: currentTime,
              duration: created.duration,
            }),
          );
        });
        created.addListener('playToEnd', () => {
          if (switchPlayerRef.current !== created) return;
          if (standbyBusyRef.current) return;
          if (loadedEngineRef.current !== 'video') return;
          setEnded(true);
        });
      } catch {
        // Listener surface unavailable — the load promise still
        // drives the switch; status reads stay primary-only.
      }
      return created;
    },
    [],
  );

  const switchQuality = useCallback(
    (targetUrl: string) => {
      // Watch chain only, remote only, and only while a video
      // candidate is live — every other state is a no-op (the
      // picker only renders for a live multi-source watch).
      if (!active || localUsable || audioFallback) return;
      if (mode !== 'watch' || kind !== 'video' || !url) return;
      if (targetUrl === url) return;
      const plan = planQualitySwitch({
        chain: candidates,
        targetUrl,
        position: playerHandle.currentTime,
        isPlaying,
      });
      if (!plan) return;
      const generation = ++switchGenerationRef.current;
      qualitySwitchRef.current = { plan, generation };
      standbyBusyRef.current = true;
      setSwitchLoading(true);
      switchPlayerRef.current?.pause();
      setCandidateIndex(plan.targetIndex);
      // The watchdog re-arms from the switch moment (the plan's
      // watchdogArmedFromPick): a stalled switch load advances.
      loadStartedAtRef.current = Date.now();
      const standby = ensureSwitchPlayer(targetUrl);
      void standby
        .replaceAsync(targetUrl)
        .then(() => {
          if (!mountedRef.current) return;
          // A settle is honoured only while THIS switch is the
          // live one and its candidate is still the chain's.
          const live = qualitySwitchRef.current;
          if (!live || live.generation !== generation) return;
          if (candidates[live.plan.targetIndex] !== targetUrl) return;
          qualitySwitchRef.current = null;
          standbyBusyRef.current = false;
          setSwitchLoading(false);
          loadedUrlRef.current = targetUrl;
          loadedEngineRef.current = 'video';
          failedUrlRef.current = null;
          setPlayerError(null);
          setEnded(false);
          // Restore position + playing state (the load promise's
          // resolution is the restore's only trigger).
          try {
            standby.currentTime = plan.resumeAt;
            if (plan.resumePlaying) standby.play();
            else standby.pause();
          } catch {
            // Released mid-switch — nothing to restore onto.
          }
          setProgress((prev) =>
            stabilizeProgress(prev, {
              current: plan.resumeAt,
              duration: prev.duration,
            }),
          );
          setStandbyStatus(standby.status);
          setStandbyPlaying(standby.playing);
          // The surface swap: the standby (frames rendering)
          // becomes the surface; the retired primary becomes the
          // standby for the next switch and is silenced.
          try {
            videoPlayer.pause();
          } catch {
            // Already released — nothing to silence.
          }
          switchPlayerRef.current = videoPlayer;
          setSwitchPlayerState(standby);
        })
        .catch((e: unknown) => {
          if (!mountedRef.current) return;
          const live = qualitySwitchRef.current;
          if (!live || live.generation !== generation) return;
          // The picked source failed to load: the chain advances
          // from the pick (handleFailure settles the switch).
          handleFailureRef.current(
            e instanceof Error ? e.message : undefined,
          );
        });
    },
    // candidates/isPlaying/kind are read live at pick time; the
    // callback identity rides the slow inputs like its siblings.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [active, localUsable, audioFallback, mode, url, videoPlayer, ensureSwitchPlayer],
  );

  // Audio: loaded through replace() on the live audio player —
  // or ADOPTED from the preload slot when the claim key matches
  // (the preloaded bytes move with the player: no re-create, no
  // re-download). An adopted player is released when playback
  // moves off it (a different candidate, deactivation, unmount).
  useEffect(() => {
    if (!active || !candidate || candidate.kind !== 'audio') return;
    if (
      loadedUrlRef.current === candidate.url &&
      loadedEngineRef.current === 'audio'
    ) {
      return;
    }
    ensureAudioMode();
    const target = candidate.url;
    let player = audioPlayerRef.current;
    const adopted =
      (claimPreloadKey
        ? adoptPreloadedPlayer(claimPreloadKey, target)
        : null) ??
      (claimKey ? adoptPreloadedPlayer(claimKey, target) : null);
    if (adopted) {
      const previousAdopted = adoptedRef.current;
      adoptedRef.current = adopted;
      audioPlayerRef.current = adopted;
      setAudioPlayerState(adopted);
      if (previousAdopted && previousAdopted !== adopted) {
        releaseAudioPlayer(previousAdopted);
      }
      player = adopted;
    }
    loadedUrlRef.current = target;
    loadedEngineRef.current = 'audio';
    setPlayerError(null);
    setEnded(false);
    setProgress({ current: 0, duration: 0 });
    try {
      if (!adopted) player.replace(target);
      // The adopted player may have been left paused at 0 with the
      // file loaded — play() is the whole point of the tap.
      player.play();
    } catch (e) {
      handleFailureRef.current(
        e instanceof Error ? e.message : undefined,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, candidate?.url, candidate?.kind]);

  // Deactivation (the detail screen switching themes): pause and
  // forget the loaded source so the next activation starts fresh.
  const wasActiveRef = useRef(false);
  useEffect(() => {
    if (active) {
      wasActiveRef.current = true;
      return;
    }
    if (!wasActiveRef.current) return;
    wasActiveRef.current = false;
    try {
      videoPlayer.pause();
    } catch {
      // Player already released — nothing to stop.
    }
    try {
      audioPlayerRef.current.pause();
    } catch {
      // Player already released — nothing to stop.
    }
    if (adoptedRef.current) {
      releaseAudioPlayer(adoptedRef.current);
      adoptedRef.current = null;
      audioPlayerRef.current = hookAudioPlayer;
      setAudioPlayerState(hookAudioPlayer);
    }
    loadedUrlRef.current = null;
    loadedEngineRef.current = null;
    failedUrlRef.current = null;
    setAudioFallback(false);
    setPlayerError(null);
    setEnded(false);
    setProgress({ current: 0, duration: 0 });
  }, [active, videoPlayer, hookAudioPlayer]);

  /* ---------------- video engine events ---------------- */
  useEventListener(videoPlayer, 'statusChange', ({ status: next, error }) => {
    if (next !== 'error') return;
    // Chain: a failed candidate hands over to the next one instead
    // of dying — only the LAST candidate's failure surfaces as the
    // error state. One failure, one handling (see handleFailure).
    handleFailureRef.current(error?.message);
  });

  useEventListener(videoPlayer, 'timeUpdate', ({ currentTime }) => {
    if (loadedEngineRef.current !== 'video') return;
    // After a quality-switch surface swap the primary is the
    // standby — its ticks must not drive progress.
    if (surfaceSwappedRef.current) return;
    setProgress((prev) =>
      stabilizeProgress(prev, {
        current: currentTime,
        duration: videoPlayer.duration,
      }),
    );
  });

  useEventListener(videoPlayer, 'playToEnd', () => {
    if (loadedEngineRef.current !== 'video') return;
    if (surfaceSwappedRef.current) return;
    setEnded(true);
  });

  /* ---------------- audio engine events ---------------- */
  // Did-just-finish (audio playToEnd) + status-error advance.
  useEffect(() => {
    void audioEventTick;
    if (loadedEngineRef.current !== 'audio') return;
    const status = audioStatusRef.current;
    if (status.error) {
      handleFailureRef.current(status.error);
      return;
    }
    if (status.didJustFinish) setEnded(true);
  }, [audioEventTick, audioStatus]);

  // Audio progress ticks (500ms status updates) feed the same
  // fast channel as the video timeUpdate, identically quantized.
  useEffect(() => {
    if (loadedEngineRef.current !== 'audio') return;
    if (!audioStatus.isLoaded) return;
    setProgress((prev) =>
      stabilizeProgress(prev, {
        current: audioStatus.currentTime,
        duration: audioStatus.duration,
      }),
    );
  }, [audioStatus]);

  /* ---------------- seek to an absolute position ----------------
     Additive sibling of seekToRatio (problem 7): a quality
     switch restores the position captured at pick time through
     the same per-engine seek the ratio path uses. Goes through
     whichever player the pool currently surfaces for video. */
  const seekTo = useCallback(
    (seconds: number) => {
      if (!Number.isFinite(seconds)) return;
      const target = Math.max(0, seconds);
      if (kind === 'audio') {
        void audioPlayerRef.current.seekTo(target).catch(() => {});
      } else if (switchPlayerRef.current && surfaceSwapped) {
        switchPlayerRef.current.currentTime = target;
      } else {
        videoPlayer.currentTime = target;
      }
      setEnded(false);
    },
    [kind, videoPlayer, surfaceSwapped],
  );

  /* ---------------- stall watchdog ---------------- */
  // A source stuck in `loading` advances the chain through the
  // failure path. The arm moment is the load's start (the detail /
  // player surfaces have no intentional hold; the countdown-hold
  // guard lives in the QUIZ engine, whose playAtMs arms it).
  const loadStartedAtRef = useRef(0);
  useEffect(() => {
    loadStartedAtRef.current = Date.now();
  }, [url, active]);
  const watchdogArmed = watchdogPollActive({
    active,
    hasSource: url !== null,
    failed: playerError !== null,
  });
  // A quality switch load lives on the STANDBY player: the main
  // status channel still reports the OLD source (ready/playing),
  // so `buffering` alone would disarm the watchdog for exactly
  // the load the spec wants it armed for (problem 7). A switch
  // in flight counts as loading from its re-stamped arm moment.
  // (switchLoading is state, not the ref, so the watchdog effect
  // re-runs when a switch starts and settles.)
  const [switchLoading, setSwitchLoading] = useState(false);
  useEffect(() => {
    if (!watchdogArmed) return;
    const id = setInterval(() => {
      if (
        watchdogShouldTrip({
          now: Date.now(),
          loadingSince:
            buffering || switchLoading ? loadStartedAtRef.current : null,
          armedFrom: loadStartedAtRef.current,
          hasSource: true,
          failed: false,
          disabled: false,
        })
      ) {
        handleFailureRef.current();
      }
    }, WATCHDOG_POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [watchdogArmed, buffering, switchLoading, url]);

  /* ---------------- mode-matched preload (inactive) ---------------- */
  // While the claim is INACTIVE, preload the claim mode's media:
  // audio candidates go to the preload slot (the whole .ogg
  // downloads into a paused player); a video candidate loads into
  // the video player, paused — the activation below (or the video
  // load effect, seeing the URL already in place) starts it
  // near-instantly. Switching mode/entry re-keys and discards.
  const preloadKey = preloadRequest?.key ?? null;
  const preloadCandidateUrl = useMemo(() => {
    if (!preloadRequest) return null;
    const tagged = tagCandidates(
      preloadRequest.candidates,
      preloadRequest.mode,
    );
    return tagged[0]?.url ?? null;
  }, [preloadRequest]);
  const preloadedVideoUrlRef = useRef<string | null>(null);
  useEffect(() => {
    if (active) return;
    if (!preloadKey || !preloadCandidateUrl) return;
    if (mediaKindForUrl(preloadCandidateUrl) === 'audio') {
      preloadAudio(preloadKey, preloadCandidateUrl);
      return;
    }
    if (preloadedVideoUrlRef.current === preloadCandidateUrl) return;
    preloadedVideoUrlRef.current = preloadCandidateUrl;
    void videoPlayer
      .replaceAsync(preloadCandidateUrl)
      .then(() => {
        // Preload only — NEVER autoplay an inactive claim.
        try {
          videoPlayer.pause();
        } catch {
          // Released — nothing to hold.
        }
      })
      .catch(() => {
        // A failed preload is silent: the tap re-runs the normal
        // load path and surfaces any real error there.
        if (preloadedVideoUrlRef.current === preloadCandidateUrl) {
          preloadedVideoUrlRef.current = null;
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, preloadKey, preloadCandidateUrl]);

  // Drop preloads when their key leaves (mode switch, entry
  // switch, slug change) — a stale preload must never be adopted.
  const lastPreloadKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = lastPreloadKeyRef.current;
    if (prev && prev !== preloadKey) discardPreload(prev);
    lastPreloadKeyRef.current = preloadKey;
  }, [preloadKey]);
  useEffect(() => {
    return () => {
      if (lastPreloadKeyRef.current) {
        discardPreload(lastPreloadKeyRef.current);
      }
    };
  }, []);

  // Watch activation over a preloaded video: the video load effect
  // above sees the URL already loaded (loadedUrlRef is only set
  // there) — this effect is what makes the activation cheap: when
  // the claim turns active with exactly the preloaded URL, mark it
  // loaded and just play.
  useEffect(() => {
    if (!active || !candidate || candidate.kind !== 'video') return;
    if (preloadedVideoUrlRef.current !== candidate.url) return;
    if (loadedUrlRef.current === candidate.url) return;
    loadedUrlRef.current = candidate.url;
    loadedEngineRef.current = 'video';
    preloadedVideoUrlRef.current = null;
    setPlayerError(null);
    setEnded(false);
    try {
      videoPlayer.play();
    } catch {
      // Released — nothing to start.
    }
  }, [active, candidate, videoPlayer]);

  /* ---------------- problem 3: next-track preload ---------------- */
  // Once the current track is stably playing (isPlaying AND not
  // buffering — the owner's gate), preload the next queue item's
  // .ogg into the slot; the provider's advance claims the same
  // key, so the track change adopts it. A skip/queue change
  // re-keys (discard + replace); an offline next needs none.
  const nextKey = shouldPreloadNext({
    isPlaying,
    buffering,
    next: nextPreload ? { slug: nextPreload.key, atEntryId: null } : null,
    nextOffline: nextPreload?.offline ?? false,
  })
    ? (nextPreload?.key ?? null)
    : null;
  const nextCandidateUrl = useMemo(() => {
    if (!nextPreload) return null;
    const tagged = tagCandidates(nextPreload.candidates, 'listen');
    return tagged.find((c) => c.kind === 'audio')?.url ?? null;
  }, [nextPreload]);
  const lastNextKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = lastNextKeyRef.current;
    if (prev && prev !== nextKey && prev !== claimKey) {
      discardPreload(prev);
    }
    lastNextKeyRef.current = nextKey;
    if (nextKey && nextCandidateUrl) preloadAudio(nextKey, nextCandidateUrl);
  }, [nextKey, nextCandidateUrl, claimKey]);
  useEffect(() => {
    return () => {
      if (lastNextKeyRef.current) discardPreload(lastNextKeyRef.current);
    };
  }, []);

  // The surface swap is per-SESSION, not per-track: a queue
  // advance / entry switch / mode flip starts the new track on
  // the PRIMARY player through the normal load effects, so the
  // pool resets — the standby is silenced and the primary
  // becomes the surface again — whenever the claim's identity
  // changes underneath a swapped surface. A quality switch does
  // NOT pass through here (it changes only the candidate index).
  const poolClaimKey = `${slug ?? ''}:${entry?.atEntryId ?? ''}:${mode}`;
  const prevPoolClaimKeyRef = useRef(poolClaimKey);
  useEffect(() => {
    if (prevPoolClaimKeyRef.current === poolClaimKey) return;
    prevPoolClaimKeyRef.current = poolClaimKey;
    if (!surfaceSwappedRef.current) return;
    const standby = switchPlayerRef.current;
    try {
      standby?.pause();
    } catch {
      // Already released — nothing to silence.
    }
    switchPlayerRef.current = null;
    standbyBusyRef.current = false;
    qualitySwitchRef.current = null;
    switchGenerationRef.current += 1;
    setSwitchLoading(false);
    setSwitchPlayerState(null);
    setStandbyStatus('idle');
    setStandbyPlaying(false);
  }, [poolClaimKey]);

  // Deactivation likewise returns the pool to the primary (the
  // deactivation effect above already pauses it) and silences
  // the standby — a re-activation starts on the primary.
  useEffect(() => {
    if (active || !surfaceSwappedRef.current) return;
    try {
      switchPlayerRef.current?.pause();
    } catch {
      // Already released — nothing to silence.
    }
    switchPlayerRef.current = null;
    standbyBusyRef.current = false;
    qualitySwitchRef.current = null;
    setSwitchLoading(false);
    setSwitchPlayerState(null);
    setStandbyStatus('idle');
    setStandbyPlaying(false);
  }, [active]);

  // History: once per entry+mode, when playback first truly starts.
  const recordedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isPlaying || !detail || !entry) return;
    const key = `${detail.slug}:${entry.atEntryId}:${mode}`;
    if (recordedKeyRef.current === key) return;
    recordedKeyRef.current = key;
    recordWatch({
      slug: detail.slug,
      atEntryId: entry.atEntryId,
      mode,
    })
      .then(() => {
        // Perf problem 4: the account's saved profile stats are
        // now stale by this play — dirty the cache entry so the
        // next profile paint waits for the fetch instead of
        // showing numbers the app knows moved.
        void markOwnProfileStatsDirty();
      })
      .catch(() => {
        // History is best-effort — a failed record never interrupts
        // playback (recordWatch already no-ops for fixture/signed-out).
      });
  }, [isPlaying, detail, entry, mode]);

  // Stop sound the moment the consumer unmounts; the hook releases
  // the players itself.
  useEffect(() => {
    return () => {
      try {
        videoPlayer.pause();
      } catch {
        // Player already released — nothing to stop.
      }
      try {
        audioPlayerRef.current.pause();
      } catch {
        // Player already released — nothing to stop.
      }
      if (adoptedRef.current) {
        releaseAudioPlayer(adoptedRef.current);
        adoptedRef.current = null;
      }
    };
  }, [videoPlayer]);

  const unavailable = url === null;

  /** The active engine's control handle (consumers' `player`). */
  const playerHandle = useMemo<ActivePlayerHandle>(() => {
    if (kind === 'audio') {
      const audio = () => audioPlayerRef.current;
      return {
        get currentTime() {
          try {
            return audio().currentTime;
          } catch {
            return 0;
          }
        },
        set currentTime(seconds: number) {
          void audio()
            .seekTo(seconds)
            .catch(() => {});
        },
        play: () => audio().play(),
        pause: () => audio().pause(),
        replay: () => {
          void audio()
            .seekTo(0)
            .catch(() => {});
          audio().play();
        },
      };
    }
    // Video: the handle drives whichever player the pool
    // currently surfaces (the primary, or the switch standby
    // after a completed quality switch) — controls must never
    // drive the retired player.
    const video = () =>
      switchPlayerRef.current && surfaceSwappedRef.current
        ? switchPlayerRef.current
        : videoPlayer;
    return {
      get currentTime() {
        return video().currentTime;
      },
      set currentTime(seconds: number) {
        video().currentTime = seconds;
      },
      play: () => video().play(),
      pause: () => video().pause(),
      replay: () => video().replay(),
    };
  }, [kind, videoPlayer]);

  const durationRef = useRef(0);
  durationRef.current = progress.duration;

  /** Seek to a 0–1 fraction of the duration (tap-to-seek bar).
      Reads the duration through its ref so the callback's
      identity stays stable across progress ticks (problem 8). */
  const seekToRatio = useCallback(
    (ratio: number) => {
      const duration = durationRef.current;
      if (duration <= 0) return;
      const target = Math.min(1, Math.max(0, ratio)) * duration;
      if (kind === 'audio') {
        void audioPlayerRef.current.seekTo(target).catch(() => {});
      } else if (switchPlayerRef.current && surfaceSwapped) {
        switchPlayerRef.current.currentTime = target;
      } else {
        videoPlayer.currentTime = target;
      }
      setEnded(false);
    },
    [kind, videoPlayer, surfaceSwapped],
  );

  /** The main button: replay once ended, else play/pause. */
  const toggleMain = useCallback(() => {
    // Video controls drive the SURFACED player (post-switch the
    // standby, not the retired primary).
    const video =
      switchPlayerRef.current && surfaceSwapped
        ? switchPlayerRef.current
        : videoPlayer;
    if (ended) {
      if (kind === 'audio') {
        const audio = audioPlayerRef.current;
        void audio.seekTo(0).catch(() => {});
        audio.play();
      } else {
        video.replay();
      }
      setEnded(false);
    } else if (isPlaying) {
      if (kind === 'audio') audioPlayerRef.current.pause();
      else video.pause();
    } else {
      if (kind === 'audio') audioPlayerRef.current.play();
      else video.play();
    }
  }, [ended, isPlaying, kind, videoPlayer, surfaceSwapped]);

  const retry = useCallback(() => {
    // From the W2 fallback, "try again" means trying the VIDEO
    // again: disengage the fallback and restart the watch chain
    // from its first candidate (the state change reloads it).
    if (audioFallback) {
      setPlayerError(null);
      failedUrlRef.current = null;
      setCandidateIndex(0);
      setAudioFallback(false);
      return;
    }
    // Retry restarts the chain from its first candidate; the index
    // change alone reloads it, so only force the load when the
    // first candidate is already the one showing.
    if (!localUsable && candidates.length > 0 && candidateIndex !== 0) {
      setPlayerError(null);
      failedUrlRef.current = null;
      setCandidateIndex(0);
      return;
    }
    if (!url) return;
    setPlayerError(null);
    failedUrlRef.current = null;
    loadedUrlRef.current = null;
    loadedEngineRef.current = null;
    if (candidate && candidate.kind === 'audio') {
      const audio = audioPlayerRef.current;
      loadedUrlRef.current = url;
      loadedEngineRef.current = 'audio';
      try {
        audio.replace(url);
        audio.play();
      } catch (e) {
        handleFailureRef.current(
          e instanceof Error ? e.message : undefined,
        );
      }
      return;
    }
    loadedUrlRef.current = url;
    // Retry loads into the SURFACED player (post-switch, the
    // standby holds the failed source — the primary is stale).
    const retryPlayer =
      switchPlayerRef.current && surfaceSwapped
        ? switchPlayerRef.current
        : videoPlayer;
    void retryPlayer
      .replaceAsync(url)
      .then(() => {
        if (mountedRef.current) retryPlayer.play();
      })
      .catch((e: unknown) => {
        if (!mountedRef.current) return;
        handleFailureRef.current(
          e instanceof Error ? e.message : undefined,
        );
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioFallback, localUsable, candidateIndex, url, candidate, videoPlayer, surfaceSwapped]);

  /* Problem 8 — the split return: `slow` carries every field
     except progress/fraction and is memoised on the slow inputs
     only, so its identity is STABLE across progress ticks; the
     top-level object composes slow + the progress pair, changing
     identity only when one of those actually changes. */
  const slow = useMemo(
    () => ({
      player: playerHandle,
      /** The expo-video player a VideoView binds (watch surface
          + hidden listen surface). Normally the primary player;
          after a completed quality switch it is the standby the
          switch loaded into (perf problem 7 — the surface swap
          keeps the old frame until the new source renders). */
      surfacePlayer,
      /** True once `surfacePlayer` is the post-switch standby —
          consumers that compare/bind the primary player object
          directly (fullscreen refs) must treat a swap as a new
          surface. */
      surfaceSwapped,
      /** Which engine the current candidate plays on. */
      surfaceKind: kind,
      /** The candidate now loaded, tagged (kind + role) — the
          hidden-video role marks the untouchable fallback. */
      candidate,
      url,
      localUsable,
      offline,
      unavailable,
      buffering,
      /** Perf problem 7: video frames for the CURRENT source
          are on screen (false before the first frame and during
          a quality switch — the artwork-under-player window). */
      framesRendered,
      /** W2: watch degraded to the listen chain's audio (opt-in
          claims only) — render artwork + an audio-only note. */
      audioFallback,
      playerError,
      ended,
      isPlaying,
      seekToRatio,
      seekTo,
      switchQuality,
      toggleMain,
      retry,
    }),
    [
      playerHandle,
      surfacePlayer,
      surfaceSwapped,
      kind,
      candidate,
      url,
      localUsable,
      offline,
      unavailable,
      buffering,
      framesRendered,
      audioFallback,
      playerError,
      ended,
      isPlaying,
      seekToRatio,
      seekTo,
      switchQuality,
      toggleMain,
      retry,
    ],
  );

  return useMemo(
    () => ({ ...slow, progress, fraction, slow }),
    [slow, progress, fraction],
  );
}

/** The engine's SLOW channel alone (perf problem 12): every field
    except progress/fraction, memoised on the slow inputs only —
    its identity is stable across progress ticks, which is what
    lets a consumer (Theme Detail's page body, via the provider's
    slow context) subscribe to the engine without re-rendering
    on every tick. */
export type PlaybackSlow = ReturnType<typeof usePlayback>['slow'];
