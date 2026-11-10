import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
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
  progressFraction,
  queuePreloadKey,
  shouldPreloadNext,
  stabilizeProgress,
  tagCandidates,
  watchdogPollActive,
  watchdogShouldTrip,
  type MediaCandidate,
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
          : videoStatus;
  const isPlaying =
    kind === 'audio' ? audioStatus.playing : videoIsPlaying;
  const buffering =
    url !== null && activeStatus === 'loading' && !playerError;
  const fraction = progressFraction(progress);

  const loadedUrlRef = useRef<string | null>(null);
  const loadedEngineRef = useRef<'audio' | 'video' | null>(null);
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
    setProgress((prev) =>
      stabilizeProgress(prev, {
        current: currentTime,
        duration: videoPlayer.duration,
      }),
    );
  });

  useEventListener(videoPlayer, 'playToEnd', () => {
    if (loadedEngineRef.current !== 'video') return;
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
  useEffect(() => {
    if (!watchdogArmed) return;
    const id = setInterval(() => {
      if (
        watchdogShouldTrip({
          now: Date.now(),
          loadingSince: buffering ? loadStartedAtRef.current : null,
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
  }, [watchdogArmed, buffering, url]);

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
    }).catch(() => {
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
    return {
      get currentTime() {
        return videoPlayer.currentTime;
      },
      set currentTime(seconds: number) {
        videoPlayer.currentTime = seconds;
      },
      play: () => videoPlayer.play(),
      pause: () => videoPlayer.pause(),
      replay: () => videoPlayer.replay(),
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
      } else {
        videoPlayer.currentTime = target;
      }
      setEnded(false);
    },
    [kind, videoPlayer],
  );

  /** The main button: replay once ended, else play/pause. */
  const toggleMain = useCallback(() => {
    if (ended) {
      if (kind === 'audio') {
        const audio = audioPlayerRef.current;
        void audio.seekTo(0).catch(() => {});
        audio.play();
      } else {
        videoPlayer.replay();
      }
      setEnded(false);
    } else if (isPlaying) {
      if (kind === 'audio') audioPlayerRef.current.pause();
      else videoPlayer.pause();
    } else {
      if (kind === 'audio') audioPlayerRef.current.play();
      else videoPlayer.play();
    }
  }, [ended, isPlaying, kind, videoPlayer]);

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
    void videoPlayer
      .replaceAsync(url)
      .then(() => {
        if (mountedRef.current) videoPlayer.play();
      })
      .catch((e: unknown) => {
        if (!mountedRef.current) return;
        handleFailureRef.current(
          e instanceof Error ? e.message : undefined,
        );
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioFallback, localUsable, candidateIndex, url, candidate, videoPlayer]);

  /* Problem 8 — the split return: `slow` carries every field
     except progress/fraction and is memoised on the slow inputs
     only, so its identity is STABLE across progress ticks; the
     top-level object composes slow + the progress pair, changing
     identity only when one of those actually changes. */
  const slow = useMemo(
    () => ({
      player: playerHandle,
      /** Always the expo-video player — the only player a
          VideoView can bind (watch surface + hidden listen
          surface). Identical to the pre-split `player` whenever
          a video candidate is active. */
      surfacePlayer: videoPlayer,
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
      /** W2: watch degraded to the listen chain's audio (opt-in
          claims only) — render artwork + an audio-only note. */
      audioFallback,
      playerError,
      ended,
      isPlaying,
      seekToRatio,
      toggleMain,
      retry,
    }),
    [
      playerHandle,
      videoPlayer,
      kind,
      candidate,
      url,
      localUsable,
      offline,
      unavailable,
      buffering,
      audioFallback,
      playerError,
      ended,
      isPlaying,
      seekToRatio,
      toggleMain,
      retry,
    ],
  );

  return useMemo(
    () => ({ ...slow, progress, fraction }),
    [slow, progress, fraction],
  );
}
