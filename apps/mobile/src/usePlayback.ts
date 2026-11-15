import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useVideoPlayer, type VideoPlayer } from 'expo-video';
import { useEvent, useEventListener } from 'expo';
import type {
  PlaybackMode,
  ThemeDetail,
  ThemeEntry,
} from '@kaikansen/contracts';
import { recordWatch } from './api';
import {
  historyRecordKey,
  INITIAL_HISTORY_RECORD_STATE,
  planHistoryRecord,
  settleHistoryRecord,
  type HistoryRecordState,
} from './historyRecording';
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
  bufferConnectionKind,
  failureAttributionDecision,
  markFailureHandled,
  mediaKindForUrl,
  progressFraction,
  queuePreloadKey,
  shouldPreloadNext,
  shouldStartQueuePrepare,
  stabilizeProgress,
  stallShouldTrip,
  surfaceReadinessAfterSwap,
  tagCandidates,
  videoBufferOptionsFor,
  videoLoadAction,
  watchSurfaceGateDecision,
  watchdogPollActive,
  type BufferConnectionKind,
  type BufferConnectionSample,
  type FailureChannel,
  type MediaCandidate,
} from './mediaEngine';
import NetInfo, { type NetInfoState } from './netInfo';
import {
  abandonDetailAudio,
  detailAudioStallShouldTrip,
  detailListenCandidates,
  getDetailAudioEntry,
  prepareDetailAudio,
  unpinDetailAudio,
  useDetailAudioProgress,
  type DetailAudioProgress,
} from './detailAudio';
import {
  abandonQueueAudio,
  getQueueAudioEntry,
  pinQueueAudioWindow,
  prepareQueueAudio,
  queueAudioStallShouldTrip,
  queueListenCandidates,
  shouldPrepareSecondNext,
  useQueueAudioProgress,
} from './queueAudio';
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
 * SURFACES (2026-11-11 restructure — regression-driven): each
 * MODE owns its surface. The watch surface is born visible
 * (in-flow 16:9, mounted with the watch UI) and is never
 * hidden-styled or restyled; the listen surface is born hidden
 * (1×1) and only ever serves the fallback. A mode switch
 * unmounts the old surface and mounts the new one — the pre-fix
 * structure that worked in the field. What makes the rebind
 * safe this time is the SURFACE DISCIPLINE: a surface reports
 * its unmount through `surfaceDetach`, which pauses the player
 * synchronously (never playing while unbound), and a watch
 * resume afterwards waits for the new surface's first rendered
 * frame through the surface-readiness gate (`notifySurface
 * FirstFrame`). The interim single always-mounted shared view
 * (whose style flipped hidden↔visible) shipped in 1.0.0/1.0.1
 * and is what the owner's field reports indict — audio always
 * fine, video dead or dying seconds in.
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
 *   re-fire; a different entry or mode records again. A FAILED
 *   post does not count as fired — the key settles only on
 *   success, so the next play-state change retries it (counts
 *   fix RC3; the decision is src/historyRecording.ts).
 * - Leaving/unmounting pauses the players (the hook releases
 *   them), so no audio leaks over other screens. Background
 *   playback is ON (owner ruling 2026-11-12 — the expo-audio
 *   mode in src/audioEngine.ts keeps audio playing when the app
 *   is backgrounded); PiP stays deliberately off.
 *
 * Playback-plan additions (2026-11-10):
 *
 * - MODE-MATCHED PRELOAD (detail claims pass `preload`): while
 *   the session is INACTIVE the engine preloads the mode's media
 *   without playing — Listen prepares the whole .ogg (since the
 *   buffer package: as a resumable cache DOWNLOAD, src/
 *   detailAudio.ts — see the BUFFER PACKAGE bullet below; the
 *   audio preload slot in src/audioEngine.ts still serves the
 *   queue paths); Watch preloads the video into the (paused)
 *   video player. A tap then ADOPTS the preloaded player/source
 *   (no re-create, no re-download) and starts near-instantly.
 *   A preload is keyed by slug+entry+mode; switching the mode or
 *   entry re-keys and discards it.
 * - STALL WATCHDOG (rebuilt 2026-11-11 watch fix — owner
 *   numbers): a NEVER-STARTED source stuck in one continuous
 *   no-progress stall advances the chain through the SAME
 *   failure path a hard error takes, but only after the kind
 *   grace (audio 30s / video 60s of continuous silence, any
 *   progress restarts the clock); a source that has started is
 *   NEVER killed for buffering (see stallShouldTrip in
 *   src/mediaEngine.ts). The quiz engine keeps its own 4s
 *   watchdog; this engine no longer uses it.
 * - PROBLEM 3 (queue next-track preload) → ROLLING QUEUE
 *   PRELOAD (owner order 2026-11-15): while a queue track
 *   plays, the provider passes the NEXT TWO queue items'
 *   resolved listen chains as `nextPreload` / `nextPreload2`.
 *   In LISTEN mode the next item's .ogg is prepared as a
 *   resumable full DOWNLOAD (src/queueAudio.ts) under the
 *   relaxed gate (mediaEngine.shouldStartQueuePrepare — the
 *   current load settled), the second-next only after the
 *   next is ready and never on metered connections; the
 *   advance leads its chain with the landed file or waits on
 *   the same transfer (30s no-progress abandon to streaming).
 *   WATCH queue claims keep the original slot path
 *   (shouldPreloadNext, stable playing, one ahead). A skip or
 *   queue change re-keys and replaces preparations in both
 *   paths. Offline next tracks need none.
 * - BUFFER PACKAGE (2026-11-11 evening — the detail claims'
 *   answer to the owner's peak-hour freeze report: both modes
 *   buffering/stuck on a healthy edge, the choke being the
 *   single-flow phone→edge road): Watch loads carry a
 *   NetInfo-sized buffer cushion (the buffer section below);
 *   a detail LISTEN claim no longer relies on streaming its
 *   first candidate: the inactive preload DOWNLOADS the whole
 *   .ogg into a cache file (src/detailAudio.ts — resumable, so
 *   a connection reset resumes instead of killing the stream
 *   and dropping the chain onto the 40–60 MB hidden video),
 *   and activation either plays that file or WAITS on the same
 *   transfer — the player watchdog stands down while waiting,
 *   and the download's own 30s no-progress verdict abandons to
 *   the streamed chain, unchanged. (Since 2026-11-15 QUEUE
 *   Listen claims take the parallel queue-audio download path
 *   — see the rolling preload bullet above; quiz preload paths
 *   are untouched.) Only claims whose session key is the
 *   engine's own detail key (slug+entry+mode) take THIS
 *   (detailAudio) download path.
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
 * Quality (owner ruling 2026-11-11 17:01 — supersedes the
 * perf-problem-7 switcher): playback is FIXED at the best
 * available quality. The watch chain starts at the highest
 * resolution and walks down ONLY on failure — that fallback is
 * reliability, not switching. There is NO quality picker and NO
 * switch path: the hero's resolution chip is a static label of
 * the source actually playing.
 *
 * Surface-readiness gate (2026-11-11 video fix): a WATCH play
 * never reaches the video player before the bound VideoView has
 * rendered its first frame for the current player instance
 * (onFirstFrameRender → notifySurfaceFirstFrame below; the pure
 * decisions live in mediaEngine). A player that starts playing
 * surfaceless can lose its video pipeline on Android
 * (expo/expo#35012 family) — the owner's 1.0.1 field report:
 * real frames for ~3s, then the chain fell to the audio
 * fallback. Held plays are remembered and released the moment
 * readiness fires; the hidden-video listen fallback is NEVER
 * gated (it plays sound-only with no frame by design); a surface
 * that never signals keeps the engine in `loading`, so the
 * stall watchdog fails through the existing chain as before.
 *
 * Watch fix (2026-11-11 evening — WATCH-102 diagnosis H1/H2):
 * the gate ALSO releases a held load/adopt/retry play when the
 * player reports 'readyToPlay' for the current source (a
 * post-detach resume still waits for the new surface's first
 * frame); the video load is issued EXACTLY ONCE per URL — the
 * inactive preload's load is recorded, and activation ADOPTS it
 * instead of replaceAsync-ing the same URL again; and failures
 * are attributed PER URL through failureAttributionDecision, so
 * one source's failure (reported on both the promise and the
 * status channel) is handled once, against that source only.
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

/** Fold a NetInfo state onto the buffer classifier's sample
    (mediaEngine.BufferConnectionSample): the connection type,
    reachability, and the platform's expensive flag where the
    state's details carry one (null when unreported). */
function bufferSampleOf(state: NetInfoState): BufferConnectionSample {
  const details = state.details as {
    isConnectionExpensive?: boolean;
  } | null;
  return {
    type: state.type,
    isInternetReachable: state.isInternetReachable,
    isConnectionExpensive:
      details && typeof details.isConnectionExpensive === 'boolean'
        ? details.isConnectionExpensive
        : null,
  };
}

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
  /** Rolling preload (2026-11-15): the SECOND-next queue item's
      listen chain — prepared as a download ONLY after the next
      item's download is ready and never on metered connections
      (queueAudio.shouldPrepareSecondNext). Null = none. */
  nextPreload2?: NextTrackPreload | null;
}) {
  const { slug, detail, entry, mode, active } = args;
  const watchAudioFallback = args.watchAudioFallback === true;
  const preloadRequest = args.preload ?? null;
  const nextPreload = args.nextPreload ?? null;
  const nextPreload2 = args.nextPreload2 ?? null;
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

  /* ---------------- buffer package: detail Listen prepare ----
     A DETAIL claim (its session preload key IS the engine's own
     slug+entry+mode claim key — the key derived below for
     adoption; queue claims carry `queue:` keys and never match)
     runs its Listen chain through the prepare cache
     (src/detailAudio.ts):
     - the chain in play is the listen chain (listen mode, or a
       watch claim degraded by W2): its prepare lives under the
       LISTEN claim key, whatever mode opened the page;
     - a LANDED prepare file leads the chain (the pure plan in
       detailAudio.detailListenCandidates — a completed library
       download still wins outright through localUsable above,
       which is the plan's first rule, so the engine consults
       the plan with libraryUri null);
     - a prepare still FETCHING at the chain's head makes the
       claim WAIT (detailWait): no streamed load is issued
       underneath the transfer. The wait is chain-head-only —
       once the chain has advanced (candidateIndex > 0) the
       remote chain stands exactly as before.
     The progress subscription is what re-renders the engine
     when the transfer lands (the snapshot flips to ready), and
     it feeds the slow channel for the listen hero's honest %. */
  const detailKeyBase =
    slug !== null && wantedEntryId != null
      ? `${slug}:${wantedEntryId}`
      : null;
  const isDetailClaim =
    detailKeyBase !== null &&
    claimPreloadKey !== null &&
    claimPreloadKey === `${detailKeyBase}:${mode}`;
  const listenClaimKey =
    detailKeyBase !== null ? `${detailKeyBase}:listen` : null;
  const chainIsListen = mode === 'listen' || audioFallback;
  const prepareKey = isDetailClaim && chainIsListen ? listenClaimKey : null;
  const prepareProgress: DetailAudioProgress | null =
    useDetailAudioProgress(prepareKey);
  const prepareEntry = prepareKey ? getDetailAudioEntry(prepareKey) : null;
  const preparedUri =
    !localUsable &&
    candidateIndex === 0 &&
    prepareEntry !== null &&
    prepareEntry.status === 'ready' &&
    prepareEntry.url === (candidates[0] ?? null)
      ? prepareEntry.uri
      : null;
  /* Rolling queue prepare (owner order 2026-11-15): a QUEUE
     claim (its session preload key is a `queue:` key — set by
     claimQueueItem / goToQueueIndex in the provider) in LISTEN
     mode runs its chain through the queue-audio download cache
     (src/queueAudio.ts), exactly as a detail claim runs through
     detailAudio: a landed prepare file leads the chain, a
     still-fetching one makes the claim WAIT on that same
     transfer (queueWait below), and a completed library
     download still wins outright (localUsable short-circuits
     above the chain entirely). Watch claims never take this
     path — the queue prepare is Listen-only by the owner's
     order, and Watch is untouched. */
  const queueClaimKey =
    claimPreloadKey !== null && claimPreloadKey.startsWith('queue:')
      ? claimPreloadKey
      : null;
  const queuePrepareKey =
    queueClaimKey !== null && mode === 'listen' ? queueClaimKey : null;
  const queuePrepareProgress = useQueueAudioProgress(queuePrepareKey);
  void queuePrepareProgress;
  const queuePrepareEntry = queuePrepareKey
    ? getQueueAudioEntry(queuePrepareKey)
    : null;
  const queuePreparedUri =
    !localUsable &&
    candidateIndex === 0 &&
    queuePrepareEntry !== null &&
    queuePrepareEntry.status === 'ready' &&
    queuePrepareEntry.url === (candidates[0] ?? null)
      ? queuePrepareEntry.uri
      : null;
  const effectiveCandidates = useMemo(
    () =>
      prepareKey !== null
        ? detailListenCandidates({
            libraryUri: null,
            preparedUri,
            remoteChain: candidates,
          })
        : queuePrepareKey !== null
          ? queueListenCandidates({
              libraryUri: null,
              preparedUri: queuePreparedUri,
              remoteChain: candidates,
            })
          : candidates,
    [prepareKey, preparedUri, queuePrepareKey, queuePreparedUri, candidates],
  );
  const detailWait =
    active &&
    prepareKey !== null &&
    !localUsable &&
    candidateIndex === 0 &&
    preparedUri === null &&
    prepareEntry !== null &&
    prepareEntry.status === 'fetching' &&
    prepareEntry.url === (candidates[0] ?? null);
  const queueWait =
    active &&
    queuePrepareKey !== null &&
    !localUsable &&
    candidateIndex === 0 &&
    queuePreparedUri === null &&
    queuePrepareEntry !== null &&
    queuePrepareEntry.status === 'fetching' &&
    queuePrepareEntry.url === (candidates[0] ?? null);
  /** Either prepare cache is being waited on (detail or queue):
      the streamed load must not start underneath the transfer,
      and the player watchdog stands down for the wait. */
  const prepareWait = detailWait || queueWait;
  const detailWaitRef = useRef(prepareWait);
  detailWaitRef.current = prepareWait;
  // The URLs whose failure was already handled (advanced past or
  // surfaced) — a failing source reports through BOTH the load
  // promise and the status listener; PER-URL attribution (watch
  // fix, mediaEngine.failureAttributionDecision) keeps one
  // failure from advancing the chain twice or being counted
  // against the NEXT candidate after an advance.
  const handledFailureUrlsRef = useRef<ReadonlySet<string>>(new Set());
  // The ONE load this engine has issued into the video player
  // (by the inactive preload or by an activation — never both):
  // activation consults it via videoLoadAction so a preloaded
  // URL is adopted, not re-loaded from zero.
  const videoLoadRef = useRef<{ url: string; settled: boolean } | null>(null);
  // A different theme/entry/mode restarts the chain from the top.
  useEffect(() => {
    setCandidateIndex(0);
    setAudioFallback(false);
    handledFailureUrlsRef.current = new Set();
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
      ? (effectiveCandidates[candidateIndex] ?? null)
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
      : (tagCandidates(effectiveCandidates, chainPurpose)[candidateIndex] ??
        null)
    : null;
  const kind: 'audio' | 'video' = candidate?.kind ?? 'video';
  // Live mirror for the surface-discipline callbacks (they read
  // the candidate's role + the playing state at detach time,
  // outside any render's closure).
  const candidateRef = useRef<MediaCandidate | null>(candidate);
  candidateRef.current = candidate;
  // Live mirror of `active` for the preload settle handlers: a
  // preload issued while inactive may settle after the claim
  // activated, and its handler must know which world it woke in.
  const activeRef = useRef(active);
  activeRef.current = active;
  // Live mirror of the session's claim key: the preload
  // bookkeeping below reads it to tell "the claim merely
  // activated" (the session still holds the key — a detail
  // prepare's pin stays with the live claim) from "the claim
  // moved on" (the pin is released; see the key-leave effect).
  const claimPreloadKeyRef = useRef(claimPreloadKey);
  claimPreloadKeyRef.current = claimPreloadKey;

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

  /* The surface binding: exactly ONE video player exists (the
     quality pool was removed with the owner's no-switching
     ruling, 2026-11-11), so the surface player is always the
     primary and its identity is stable for the engine's life. */
  const surfacePlayer: VideoPlayer = videoPlayer;
  const surfaceStatus = videoStatus;
  const surfaceIsPlaying = videoIsPlaying;
  // Ref mirror of the video player's status — the gate decision
  // (a stable callback) reads the CURRENT status: 'readyToPlay'
  // is the gate's second release signal (watch fix, fix 4).
  const videoStatusRef = useRef(videoStatus);
  videoStatusRef.current = videoStatus;

  /* ---------------- buffer package: the Watch cushion ---------
     The video player's buffer cushion is sized by the
     CONNECTION at each load (buffer package, 2026-11-11
     evening — the pure decision lives in mediaEngine:
     bufferConnectionKind + videoBufferOptionsFor). The engine
     keeps the latest NetInfo sample; loads read the classified
     kind through the ref mirror, so a load issued from any
     callback uses the freshest class. expo-video's defaults
     (Android: ~20s forward, 2s to start) left almost no runway
     for a dipping single-flow road to ride out on — the owner's
     1.0.3 peak-hour freezes on BOTH detail modes. */
  const [connectionSample, setConnectionSample] =
    useState<BufferConnectionSample | null>(null);
  useEffect(() => {
    let live = true;
    NetInfo.fetch()
      .then((state) => {
        if (live) setConnectionSample(bufferSampleOf(state));
      })
      .catch(() => {
        // No sample: the classifier defaults to metered.
      });
    const unsubscribe = NetInfo.addEventListener((state) => {
      setConnectionSample(bufferSampleOf(state));
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);
  const connectionKindRef = useRef<BufferConnectionKind>('metered');
  connectionKindRef.current = bufferConnectionKind(connectionSample);

  /** Set the player's buffer cushion for ONE load, from its
      candidate (watch candidates get their connection's Watch
      profile; the hidden-video listen fallback always gets the
      metered profile — an audio-only rescue must not gorge the
      road it exists to survive). Applied as each load is issued,
      so a claim on a changed connection re-tunes. */
  const applyVideoBufferOptions = useCallback(
    (forCandidate: MediaCandidate) => {
      try {
        videoPlayer.bufferOptions = videoBufferOptionsFor({
          role: forCandidate.role,
          connection: connectionKindRef.current,
        });
      } catch {
        // Player released — nothing to tune.
      }
    },
    [videoPlayer],
  );

  /* ---------------- surface-readiness gate (2026-11-11) -------
     A WATCH play must not reach the video player until the
     bound VideoView has rendered its first frame FOR THE
     CURRENT PLAYER INSTANCE: a player started surfaceless can
     lose its video pipeline on Android (expo/expo#35012 family —
     frames for ~3s, then the player errors and the chain falls
     back: the owner's 1.0.1 field report). Readiness arrives via
     notifySurfaceFirstFrame, wired from the VideoView's
     onFirstFrameRender prop by whichever screen owns the visible
     surface (player route / theme detail hero). The hidden 1×1
     listen surface passes visible=false — its frames never mark
     readiness, so the hidden-video listen fallback stays
     ungated by construction as well as by the role rule.
     Readiness is tracked by an opaque per-instance key so any
     future surface-player swap re-arms the gate through
     surfaceReadinessAfterSwap (mediaEngine). */
  const surfacePlayerKey = 'primary';
  const [surfaceReadyPlayerKey, setSurfaceReadyPlayerKey] =
    useState<string | null>(null);
  const surfaceReadyPlayerKeyRef = useRef<string | null>(null);
  const surfacePlayerKeyRef = useRef(surfacePlayerKey);
  const gateReadiness = surfaceReadinessAfterSwap({
    previousPlayerKey: surfacePlayerKeyRef.current,
    nextPlayerKey: surfacePlayerKey,
    readyPlayerKey: surfaceReadyPlayerKeyRef.current,
  });
  const surfaceReadyRef = useRef(gateReadiness.ready);
  surfaceReadyRef.current = gateReadiness.ready;
  const surfaceIsPlayingRef = useRef(surfaceIsPlaying);
  surfaceIsPlayingRef.current = surfaceIsPlaying;
  // Play requests remembered while the gate holds (one per slot:
  // the main source load + the preload-adoption path). A newer
  // load supersedes an older held request — the callbacks read
  // the engine's live refs, so releasing the newest release is
  // enough; stale ones are overwritten, never queued.
  const heldPlaysRef = useRef<{
    load: (() => void) | null;
    adopt: (() => void) | null;
    retry: (() => void) | null;
    resume: (() => void) | null;
  }>({ load: null, adopt: null, retry: null, resume: null });

  // Drain the remembered gate-held plays; the callbacks
  // re-check their own load's currency before touching the
  // player, so releasing a stale slot is harmless. A RESUME held
  // for a post-detach surface is only drained by that surface's
  // own first frame (the detach discipline), never by the
  // readyToPlay release.
  const releaseHeldPlays = useCallback((includeResume: boolean) => {
    const held = heldPlaysRef.current;
    heldPlaysRef.current = {
      load: null,
      adopt: null,
      retry: null,
      resume: includeResume ? null : held.resume,
    };
    const releases = includeResume
      ? [held.load, held.adopt, held.retry, held.resume]
      : [held.load, held.adopt, held.retry];
    for (const release of releases) {
      if (!release) continue;
      try {
        release();
      } catch {
        // Player released — nothing to start.
      }
    }
  }, []);

  const playVideoGated = useCallback(
    (
      slot: 'load' | 'adopt' | 'retry' | 'resume',
      doPlay: () => void,
      forCandidate: MediaCandidate,
    ) => {
      const decision = watchSurfaceGateDecision({
        kind: forCandidate.kind,
        role: forCandidate.role,
        surfaceReady: surfaceReadyRef.current,
        // Fix 4: 'readyToPlay' for the current source also
        // releases a fresh play. The resume slot is exempt — it
        // exists to wait for the NEW surface after a detach.
        playerReadyToPlay:
          slot !== 'resume' && videoStatusRef.current === 'readyToPlay',
      });
      if (decision === 'play') {
        heldPlaysRef.current[slot] = null;
        try {
          doPlay();
        } catch {
          // Player released — nothing to start.
        }
        return;
      }
      heldPlaysRef.current[slot] = doPlay;
    },
    [],
  );

  const notifySurfaceFirstFrame = useCallback(
    (args: { visible: boolean }) => {
      if (!args.visible) return;
      if (surfaceReadyPlayerKeyRef.current === surfacePlayerKey) return;
      surfaceReadyPlayerKeyRef.current = surfacePlayerKey;
      setSurfaceReadyPlayerKey(surfacePlayerKey);
      // Release every remembered play, newest state first.
      releaseHeldPlays(true);
    },
    [releaseHeldPlays],
  );

  // Fix 4, the release side: when the player reaches
  // 'readyToPlay' for the current source, any load/adopt/retry
  // play the gate is holding is released even if no first frame
  // has rendered yet (the source is loaded and playable — the
  // safety the frame was proxying for). Resume plays are NOT
  // released here (see releaseHeldPlays).
  useEffect(() => {
    if (videoStatus !== 'readyToPlay') return;
    releaseHeldPlays(false);
  }, [videoStatus, releaseHeldPlays]);

  /* Surface detach discipline (2026-11-11 restructure): a
     surface calls this as it unmounts — a mode switch unmounts
     the old mode's surface and mounts the new mode's, and the
     player must NEVER be playing while unbound (that mid-play
     rebind is what the regression evidence indicts). The pause
     lands synchronously; readiness for the outgoing surface is
     forgotten (per-instance rule); and if the video player was
     playing, a resume is remembered and released by the gate
     when the NEW surface renders its first frame — for a watch
     surface. For the hidden listen surface the resume plays at
     once through the gate's hidden-video bypass (its semantics
     never wait for a frame). Audio candidates are untouched:
     expo-audio has no surface at all. */
  const surfaceDetach = useCallback((args: { resume: boolean }) => {
    if (loadedEngineRef.current !== 'video') return;
    const wasPlaying = surfaceIsPlayingRef.current;
    try {
      videoPlayer.pause();
    } catch {
      // Player already released — nothing to stop.
    }
    if (surfaceReadyPlayerKeyRef.current !== null) {
      surfaceReadyPlayerKeyRef.current = null;
      setSurfaceReadyPlayerKey(null);
    }
    if (args.resume && wasPlaying) {
      const url = loadedUrlRef.current;
      if (url === null) return;
      const current = candidateRef.current;
      if (!current) return;
      playVideoGated(
        'resume',
        () => {
          if (loadedUrlRef.current === url) videoPlayer.play();
        },
        current,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoPlayer, playVideoGated]);

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
   * rejection and the player's status 'error'; the report is
   * vetted through failureAttributionDecision (watch fix) —
   * currency + per-URL attribution + status-channel
   * subordination — so each failing source is handled exactly
   * once, against itself only. Callers that know their load pass
   * `{ url, channel }`; bare calls attribute to the current load
   * on the 'sync' channel (the watchdog, synchronous throws).
   * (Load rejections used to be swallowed entirely, which let a
   * failed watch source sit on a silent black surface — no
   * frames, no error, no retry.)
   */
  const handleFailureRef = useRef<
    (
      message?: string,
      attribution?: { url: string | null; channel: FailureChannel },
    ) => void
  >(() => {});
  handleFailureRef.current = (message, attribution) => {
    const reportUrl = attribution ? attribution.url : loadedUrlRef.current;
    const channel: FailureChannel = attribution?.channel ?? 'sync';
    const decision = failureAttributionDecision({
      channel,
      reportUrl,
      currentUrl: loadedUrlRef.current,
      currentLoadSettled:
        videoLoadRef.current !== null &&
        videoLoadRef.current.url === loadedUrlRef.current &&
        videoLoadRef.current.settled,
      handledUrls: handledFailureUrlsRef.current,
    });
    if (decision === 'ignore') return;
    if (reportUrl !== null) {
      handledFailureUrlsRef.current = markFailureHandled(
        handledFailureUrlsRef.current,
        reportUrl,
      );
    }
    // A remembered gate-held play belongs to the source that
    // just failed — never let it fire onto the next candidate.
    heldPlaysRef.current = {
      load: null,
      adopt: null,
      retry: null,
      resume: null,
    };
    if (!localUsable && candidateIndex + 1 < effectiveCandidates.length) {
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
      // handled-failure set resets so the audio chain's own
      // failures are handled fresh; the consumer renders the
      // artwork and the audio-only note off `audioFallback`.
      handledFailureUrlsRef.current = new Set();
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
  // its statusChange 'error' both feed handleFailure (attributed
  // per URL — see handleFailure). The play that follows the load
  // is SURFACE-GATED (2026-11-11 video fix): a watch candidate's
  // play is held until the bound surface renders its first frame
  // for this player (or the player reports readyToPlay — fix 4);
  // the hidden-video listen candidate plays straight through.
  //
  // SINGLE LOAD (watch fix, fix 1): the load below consults
  // videoLoadAction against videoLoadRef — the ONE load this
  // engine has issued into the player. If the inactive preload
  // already issued a load for this exact URL, activation ADOPTS
  // it (settled → gated play, no second replaceAsync) or WAITS
  // for it (in flight → its settle handler, in the preload
  // effect, performs the gated play / failure). Only a URL with
  // no issued load is loaded here.
  useEffect(() => {
    if (!active || !candidate || candidate.kind !== 'video') return;
    const url = candidate.url;
    const forCandidate = candidate;
    const action = videoLoadAction({
      candidateUrl: url,
      issuedUrl: videoLoadRef.current?.url ?? null,
      issuedSettled: videoLoadRef.current?.settled ?? false,
    });
    if (action === 'wait') return;
    if (action === 'adopt') {
      if (loadedUrlRef.current === url) {
        // Already adopted once — a re-run must not replay a
        // source the consumer has since paused.
        return;
      }
      loadedUrlRef.current = url;
      loadedEngineRef.current = 'video';
      setPlayerError(null);
      setEnded(false);
      setProgress({ current: 0, duration: 0 });
      applyVideoBufferOptions(forCandidate);
      playVideoGated(
        'adopt',
        () => {
          if (loadedUrlRef.current === url) videoPlayer.play();
        },
        forCandidate,
      );
      return;
    }
    if (loadedUrlRef.current === url) return;
    loadedUrlRef.current = url;
    loadedEngineRef.current = 'video';
    setPlayerError(null);
    setEnded(false);
    setProgress({ current: 0, duration: 0 });
    const issued = { url, settled: false };
    videoLoadRef.current = issued;
    applyVideoBufferOptions(forCandidate);
    void videoPlayer
      .replaceAsync(url)
      .then(() => {
        if (videoLoadRef.current === issued) issued.settled = true;
        if (!mountedRef.current) return;
        // A superseded load must not start the source that
        // replaced it — the release re-checks currency.
        playVideoGated(
          'load',
          () => {
            if (loadedUrlRef.current === url) videoPlayer.play();
          },
          forCandidate,
        );
      })
      .catch((e: unknown) => {
        if (videoLoadRef.current === issued) issued.settled = true;
        // A superseded load (a newer source already took over)
        // must not fail the source that replaced it.
        if (!mountedRef.current || loadedUrlRef.current !== url) {
          return;
        }
        handleFailureRef.current(
          e instanceof Error ? e.message : undefined,
          { url, channel: 'promise' },
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
    // Buffer package: while the claim WAITS on its prepare
    // download (detailWait), the streamed load of the same URL
    // must not start underneath the transfer. The wait lifting
    // re-runs this effect (it is a dep): the candidate is then
    // the landed file itself, or — after the download stall
    // verdict abandoned the transfer — the untouched remote
    // chain head, loaded exactly as before the package.
    if (detailWaitRef.current) return;
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
    // An audio takeover retires the video load record: if the
    // chain later returns to a video candidate (the hidden-video
    // last resort is often the SAME URL that failed as a watch
    // candidate), it must load FRESH, not "adopt" a load that
    // already failed once.
    videoLoadRef.current = null;
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
  }, [active, candidate?.url, candidate?.kind, detailWait, queueWait]);

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
    videoLoadRef.current = null;
    handledFailureUrlsRef.current = new Set();
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
    // CURRENCY (watch fix, fix 2): this channel cannot name its
    // source, so the report is attributed to the CURRENT load and
    // vetted by failureAttributionDecision — while that load is
    // still in flight its promise channel owns the failure, and
    // a stale duplicate of the PREVIOUS candidate's error (the
    // 1.0.2 chain-killer) is ignored instead of failing the
    // candidate that replaced it.
    handleFailureRef.current(error?.message, {
      url: loadedUrlRef.current,
      channel: 'status',
    });
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

  /* ---------------- seek to an absolute position ----------------
     Additive sibling of seekToRatio: the same per-engine seek
     the ratio path uses, on the one video player. */
  const seekTo = useCallback(
    (seconds: number) => {
      if (!Number.isFinite(seconds)) return;
      const target = Math.max(0, seconds);
      if (kind === 'audio') {
        void audioPlayerRef.current.seekTo(target).catch(() => {});
      } else {
        videoPlayer.currentTime = target;
      }
      setEnded(false);
    },
    [kind, videoPlayer],
  );

  /* ---------------- stall watchdog (rebuilt, watch fix) ------- */
  // Owner rules (2026-11-11): the clock measures ONE CONTINUOUS
  // no-progress stall — it starts when a buffering episode BEGINS
  // (the buffering rising edge), and any progress (leaving
  // 'loading', an advancing tick, a known duration, playing)
  // restarts it. A source that has STARTED is never killed for
  // buffering at all; a never-started source gets the kind grace
  // (audio 30s / video 60s) of continuous silence before the
  // chain advances through the failure path. (The QUIZ engine
  // keeps its own watchdog — mediaEngine.watchdogShouldTrip.)
  const stallSinceRef = useRef<number | null>(null);
  const startedUrlRef = useRef<string | null>(null);
  // Started = genuinely under way for THIS source: playing, or
  // position past 0, or (video) frames on screen.
  useEffect(() => {
    if (!url) return;
    if (
      isPlaying ||
      progress.current > 0 ||
      (kind === 'video' && framesRendered)
    ) {
      startedUrlRef.current = url;
    }
  }, [url, isPlaying, progress.current, kind, framesRendered]);
  // The stall episode: stamped on the buffering rising edge,
  // cleared the moment buffering ends.
  useEffect(() => {
    if (buffering) {
      if (stallSinceRef.current === null) {
        stallSinceRef.current = Date.now();
      }
    } else {
      stallSinceRef.current = null;
    }
  }, [buffering]);
  // A newly-known duration mid-stall is progress too: restart
  // the episode clock (the stall continues, its silence doesn't).
  useEffect(() => {
    if (progress.duration > 0 && stallSinceRef.current !== null) {
      stallSinceRef.current = Date.now();
    }
  }, [progress.duration]);
  // Buffer package: while the claim waits on its prepare
  // download (detailWait), the player watchdog stands down —
  // the "buffering" it would judge is the wait itself, and the
  // download's own stall poll below owns that clock.
  const watchdogArmed =
    watchdogPollActive({
      active,
      hasSource: url !== null,
      failed: playerError !== null,
    }) && !prepareWait;
  useEffect(() => {
    if (!watchdogArmed) return;
    const id = setInterval(() => {
      if (
        stallShouldTrip({
          now: Date.now(),
          kind,
          stallSince: stallSinceRef.current,
          hasStarted: url !== null && startedUrlRef.current === url,
          hasSource: true,
          failed: false,
          disabled: false,
        })
      ) {
        handleFailureRef.current();
      }
    }, WATCHDOG_POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [watchdogArmed, kind, url]);

  /* ---------------- buffer package: download stall poll ------
     While a detail Listen claim waits on its prepare download,
     this poll owns the wait's clock: the module's pure decision
     (30s without a byte of progress — the transfer stamps every
     byte itself; a started playback is immune by construction,
     since a wait means nothing has loaded) abandons the
     transfer, the entry's removal lifts the wait, and the audio
     load effect falls through to the streamed chain, unchanged,
     with per-URL failure attribution intact. */
  useEffect(() => {
    if (!detailWait || !prepareKey) return;
    const key = prepareKey;
    const id = setInterval(() => {
      const entry = getDetailAudioEntry(key);
      if (!entry) return;
      if (
        detailAudioStallShouldTrip({
          status: entry.status,
          now: Date.now(),
          lastProgressAt: entry.lastProgressAt,
          playbackStarted: false,
        })
      ) {
        abandonDetailAudio(key);
      }
    }, WATCHDOG_POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [detailWait, prepareKey]);

  /* The queue wait's stall poll — the same 30s no-progress
     rule (queueAudioStallShouldTrip shares detailAudio's
     decision): abandoning the transfer drops the entry, lifts
     the wait, and the audio load effect falls through to the
     streamed chain, unchanged. A started playback is immune
     by construction (a wait means nothing has loaded). */
  useEffect(() => {
    if (!queueWait || !queuePrepareKey) return;
    const key = queuePrepareKey;
    const id = setInterval(() => {
      const entry = getQueueAudioEntry(key);
      if (!entry) return;
      if (
        queueAudioStallShouldTrip({
          status: entry.status,
          now: Date.now(),
          lastProgressAt: entry.lastProgressAt,
          playbackStarted: false,
        })
      ) {
        abandonQueueAudio(key);
      }
    }, WATCHDOG_POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [queueWait, queuePrepareKey]);

  /* ---------------- mode-matched preload (inactive) ---------------- */
  // While the claim is INACTIVE, preload the claim mode's media:
  // audio candidates go to the preload slot (the whole .ogg
  // downloads into a paused player); a video candidate loads into
  // the video player, paused — the activation below (or the video
  // load effect, seeing the URL already in place) starts it
  // near-instantly. Switching mode/entry re-keys and discards.
  const preloadKey = preloadRequest?.key ?? null;
  const preloadCandidate = useMemo(() => {
    if (!preloadRequest) return null;
    const tagged = tagCandidates(
      preloadRequest.candidates,
      preloadRequest.mode,
    );
    return tagged[0] ?? null;
  }, [preloadRequest]);
  const preloadCandidateUrl = preloadCandidate?.url ?? null;
  const preloadedVideoUrlRef = useRef<string | null>(null);
  // The preload keys this engine has fed to the detail prepare
  // cache (buffer package): when such a key is retired, its
  // entry is UNPINNED (left warm for a return visit), never
  // slot-discarded — the audio slot never held anything for it.
  const detailPreparedKeysRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (active) return;
    if (!preloadKey || !preloadCandidateUrl) return;
    if (mediaKindForUrl(preloadCandidateUrl) === 'audio') {
      // Buffer package: a DETAIL claim's Listen preload is the
      // prepare DOWNLOAD (src/detailAudio.ts), not a slot stream
      // — a stream dies on the first connection reset, where the
      // resumable download survives it, and the landed file
      // plays immune to the road. The gate is the key itself:
      // only the engine's own detail key matches claimKey (the
      // provider's queue keys never do), so every other preload
      // consumer keeps the slot path below, untouched.
      if (claimKey !== null && preloadKey === claimKey) {
        detailPreparedKeysRef.current.add(preloadKey);
        prepareDetailAudio(preloadKey, preloadCandidateUrl);
        return;
      }
      preloadAudio(preloadKey, preloadCandidateUrl);
      return;
    }
    if (preloadedVideoUrlRef.current === preloadCandidateUrl) return;
    // SINGLE LOAD (watch fix, fix 1): this preload load is THE
    // load for its URL — it is recorded in videoLoadRef as it is
    // issued, so a later activation ADOPTS it (videoLoadAction)
    // instead of issuing a second replaceAsync of the same URL.
    if (
      videoLoadAction({
        candidateUrl: preloadCandidateUrl,
        issuedUrl: videoLoadRef.current?.url ?? null,
        issuedSettled: videoLoadRef.current?.settled ?? false,
      }) !== 'issue'
    ) {
      preloadedVideoUrlRef.current = preloadCandidateUrl;
      return;
    }
    preloadedVideoUrlRef.current = preloadCandidateUrl;
    const issued = { url: preloadCandidateUrl, settled: false };
    videoLoadRef.current = issued;
    if (preloadCandidate) applyVideoBufferOptions(preloadCandidate);
    void videoPlayer
      .replaceAsync(preloadCandidateUrl)
      .then(() => {
        if (videoLoadRef.current === issued) issued.settled = true;
        if (!mountedRef.current) return;
        if (!activeRef.current) {
          // Preload only — NEVER autoplay an inactive claim.
          try {
            videoPlayer.pause();
          } catch {
            // Released — nothing to hold.
          }
          return;
        }
        // The claim activated while this preload was in flight
        // and the activation's load effect deferred to this load
        // (videoLoadAction 'wait'): its settle performs the
        // adoption — mark the source loaded and play, gated.
        if (preloadedVideoUrlRef.current !== preloadCandidateUrl) return;
        const forCandidate = candidateRef.current;
        if (!forCandidate || forCandidate.url !== preloadCandidateUrl) return;
        preloadedVideoUrlRef.current = null;
        loadedUrlRef.current = preloadCandidateUrl;
        loadedEngineRef.current = 'video';
        setPlayerError(null);
        setEnded(false);
        playVideoGated(
          'adopt',
          () => {
            if (loadedUrlRef.current === preloadCandidateUrl) {
              videoPlayer.play();
            }
          },
          forCandidate,
        );
      })
      .catch((e: unknown) => {
        if (videoLoadRef.current === issued) videoLoadRef.current = null;
        if (preloadedVideoUrlRef.current === preloadCandidateUrl) {
          preloadedVideoUrlRef.current = null;
        }
        // A failed preload while INACTIVE stays silent: the tap
        // re-runs the normal load path and surfaces any real
        // error there. If the claim already activated over this
        // load (the 'wait' case), the failure is the current
        // candidate's own — report it, attributed to its URL.
        if (!mountedRef.current || !activeRef.current) return;
        if (candidateRef.current?.url !== preloadCandidateUrl) return;
        if (loadedUrlRef.current !== null && loadedUrlRef.current !== preloadCandidateUrl) return;
        loadedUrlRef.current = preloadCandidateUrl;
        loadedEngineRef.current = 'video';
        handleFailureRef.current(
          e instanceof Error ? e.message : undefined,
          { url: preloadCandidateUrl, channel: 'promise' },
        );
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, preloadKey, preloadCandidateUrl]);

  // Drop preloads when their key leaves (mode switch, entry
  // switch, slug change) — a stale preload must never be adopted.
  // Buffer package: a retired DETAIL prepare key is unpinned
  // instead (its file stays warm under the cache's retention;
  // prepareDetailAudio's own pin-move is the backstop for keys
  // retired by activation, where this effect sees no key change
  // at all). A key the live session still holds — it merely
  // activated — keeps its pin.
  const lastPreloadKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = lastPreloadKeyRef.current;
    if (prev && prev !== preloadKey) {
      if (detailPreparedKeysRef.current.has(prev)) {
        if (prev !== claimPreloadKeyRef.current) {
          detailPreparedKeysRef.current.delete(prev);
          unpinDetailAudio(prev);
        }
      } else {
        discardPreload(prev);
      }
    }
    lastPreloadKeyRef.current = preloadKey;
  }, [preloadKey]);
  useEffect(() => {
    return () => {
      const last = lastPreloadKeyRef.current;
      if (!last) return;
      if (detailPreparedKeysRef.current.has(last)) {
        unpinDetailAudio(last);
      } else {
        discardPreload(last);
      }
    };
  }, []);

  // Watch activation over a preloaded video needs NO separate
  // effect any more (watch fix, fix 1): the video load effect
  // adopts the recorded preload load via videoLoadAction, and a
  // preload that settles after activation performs the adoption
  // play from its own settle handler in the preload effect. (The
  // former adoption effect here always lost its race with the
  // load effect's second replaceAsync — diagnosis §1.3.)

  /* ------------- rolling queue preload (2026-11-15) ----------
     Owner order, Listen mode: the next queue items' .ogg files
     are prepared as resumable DOWNLOADS (src/queueAudio.ts)
     instead of the problem-3 slot stream (avoiding double
     traffic — a Listen queue claim now uses exactly one
     prepare path). The gate is the RELAXED one
     (mediaEngine.shouldStartQueuePrepare): it opens as soon
     as the current track's load has settled (ready-to-play or
     playing), not after stable non-buffering play — see that
     function's note for why. The rolling second (N+2) is
     prepared ONLY once N+1's entry is ready and never on a
     metered connection (queueAudio.shouldPrepareSecondNext) —
     sequential, never parallel. Skip/queue changes re-key:
     preparations whose key leaves the live window (current
     claim + next + second) are discarded; the live claim's own
     key is never discarded (its entry is the chain head the
     advance waits on / plays). Entries are otherwise left warm
     in the bounded cache — there is deliberately no unmount
     discard: the provider is app-level, and a backgrounded
     app's transfers belong to the native download layer, not
     to any screen's lifecycle.
     Watch mode keeps the legacy problem-3 slot path below,
     byte-for-byte in behaviour (the owner's order is
     Listen-only; Watch is untouched). */
  const nextCandidateUrl = useMemo(() => {
    if (!nextPreload) return null;
    const tagged = tagCandidates(nextPreload.candidates, 'listen');
    return tagged.find((c) => c.kind === 'audio')?.url ?? null;
  }, [nextPreload]);
  const secondCandidateUrl = useMemo(() => {
    if (!nextPreload2) return null;
    const tagged = tagCandidates(nextPreload2.candidates, 'listen');
    return tagged.find((c) => c.kind === 'audio')?.url ?? null;
  }, [nextPreload2]);
  const listenQueue = mode === 'listen';
  const nextPrepareKey =
    listenQueue &&
    shouldStartQueuePrepare({
      active,
      currentLoaded: activeStatus === 'readyToPlay',
      isPlaying,
      next: nextPreload ? { slug: nextPreload.key, atEntryId: null } : null,
      nextOffline: nextPreload?.offline ?? false,
    })
      ? (nextPreload?.key ?? null)
      : null;
  const nextEntryProgress = useQueueAudioProgress(nextPrepareKey);
  const secondPrepareKey =
    listenQueue &&
    nextPrepareKey !== null &&
    shouldPrepareSecondNext({
      hasSecond:
        nextPreload2 !== null && !nextPreload2.offline && secondCandidateUrl !== null,
      firstStatus: nextEntryProgress?.status ?? null,
      metered: bufferConnectionKind(connectionSample) === 'metered',
    })
      ? (nextPreload2?.key ?? null)
      : null;
  const preparedKeysRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!listenQueue) return;
    const live = new Set<string>();
    if (queueClaimKey) live.add(queueClaimKey);
    if (nextPrepareKey) live.add(nextPrepareKey);
    if (secondPrepareKey) live.add(secondPrepareKey);
    pinQueueAudioWindow([...live]);
    for (const key of [...preparedKeysRef.current]) {
      if (!live.has(key)) {
        preparedKeysRef.current.delete(key);
        abandonQueueAudio(key);
      }
    }
    if (nextPrepareKey && nextCandidateUrl) {
      preparedKeysRef.current.add(nextPrepareKey);
      prepareQueueAudio(nextPrepareKey, nextCandidateUrl);
    }
    if (secondPrepareKey && secondCandidateUrl) {
      preparedKeysRef.current.add(secondPrepareKey);
      prepareQueueAudio(secondPrepareKey, secondCandidateUrl);
    }
  }, [
    listenQueue,
    queueClaimKey,
    nextPrepareKey,
    nextCandidateUrl,
    secondPrepareKey,
    secondCandidateUrl,
  ]);

  /* Legacy problem-3 slot path — WATCH queue claims only now
     (Listen queues use the download cache above): once the
     current track is stably playing, preload the next item's
     .ogg into the slot; a skip/queue change re-keys (discard +
     replace); an offline next needs none. */
  const nextKey = !listenQueue && shouldPreloadNext({
    isPlaying,
    buffering,
    next: nextPreload ? { slug: nextPreload.key, atEntryId: null } : null,
    nextOffline: nextPreload?.offline ?? false,
  })
    ? (nextPreload?.key ?? null)
    : null;
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

  // A claim change retires any remembered gate-held play: it
  // belonged to the previous claim's source (the new claim's own
  // load effect re-requests play for its candidate).
  const gateClaimKey = `${slug ?? ''}:${entry?.atEntryId ?? ''}:${mode}`;
  const prevGateClaimKeyRef = useRef(gateClaimKey);
  useEffect(() => {
    if (prevGateClaimKeyRef.current === gateClaimKey) return;
    prevGateClaimKeyRef.current = gateClaimKey;
    heldPlaysRef.current = {
      load: null,
      adopt: null,
      retry: null,
      resume: null,
    };
  }, [gateClaimKey]);

  // History: once per entry+mode, when playback first truly
  // starts. The decision lives in src/historyRecording.ts (pure,
  // unit-pinned): the dedupe key settles as recorded only when
  // the POST succeeds — a dropped POST (the API cold-starts and
  // drops requests) re-fires on the next play-state change
  // instead of silently eating that entry+mode's record
  // (counts fix RC3, 2026-11-12).
  const historyRecordStateRef = useRef<HistoryRecordState>(
    INITIAL_HISTORY_RECORD_STATE,
  );
  useEffect(() => {
    const key =
      detail && entry
        ? historyRecordKey(detail.slug, entry.atEntryId, mode)
        : null;
    const plan = planHistoryRecord(historyRecordStateRef.current, {
      isPlaying,
      key,
    });
    historyRecordStateRef.current = plan.state;
    if (!plan.fireKey || !detail || !entry) return;
    const fireKey = plan.fireKey;
    recordWatch({
      slug: detail.slug,
      atEntryId: entry.atEntryId,
      mode,
    })
      .then(() => {
        historyRecordStateRef.current = settleHistoryRecord(
          historyRecordStateRef.current,
          fireKey,
          true,
        );
        // Perf problem 4: the account's saved profile stats are
        // now stale by this play — dirty the cache entry so the
        // next profile paint waits for the fetch instead of
        // showing numbers the app knows moved.
        void markOwnProfileStatsDirty();
      })
      .catch(() => {
        historyRecordStateRef.current = settleHistoryRecord(
          historyRecordStateRef.current,
          fireKey,
          false,
        );
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
    // Video: the handle drives the one video player.
    const video = () => videoPlayer;
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
      } else {
        videoPlayer.currentTime = target;
      }
      setEnded(false);
    },
    [kind, videoPlayer],
  );

  /** The main button: replay once ended, else play/pause. */
  const toggleMain = useCallback(() => {
    const video = videoPlayer;
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
  }, [ended, isPlaying, kind, videoPlayer]);

  const retry = useCallback(() => {
    // From the W2 fallback, "try again" means trying the VIDEO
    // again: disengage the fallback and restart the watch chain
    // from its first candidate (the state change reloads it).
    if (audioFallback) {
      setPlayerError(null);
      handledFailureUrlsRef.current = new Set();
      setCandidateIndex(0);
      setAudioFallback(false);
      return;
    }
    // Retry restarts the chain from its first candidate; the index
    // change alone reloads it, so only force the load when the
    // first candidate is already the one showing.
    if (
      !localUsable &&
      effectiveCandidates.length > 0 &&
      candidateIndex !== 0
    ) {
      setPlayerError(null);
      handledFailureUrlsRef.current = new Set();
      setCandidateIndex(0);
      return;
    }
    if (!url) return;
    setPlayerError(null);
    handledFailureUrlsRef.current = new Set();
    loadedUrlRef.current = null;
    loadedEngineRef.current = null;
    videoLoadRef.current = null;
    startedUrlRef.current = null;
    stallSinceRef.current = null;
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
    const retryCandidate = candidate;
    const issued = { url, settled: false };
    videoLoadRef.current = issued;
    if (retryCandidate) applyVideoBufferOptions(retryCandidate);
    void videoPlayer
      .replaceAsync(url)
      .then(() => {
        if (videoLoadRef.current === issued) issued.settled = true;
        if (!mountedRef.current) return;
        // The retry play is surface-gated like any watch play.
        if (retryCandidate) {
          playVideoGated(
            'retry',
            () => {
              if (loadedUrlRef.current === url) videoPlayer.play();
            },
            retryCandidate,
          );
        } else {
          videoPlayer.play();
        }
      })
      .catch((e: unknown) => {
        if (videoLoadRef.current === issued) issued.settled = true;
        if (!mountedRef.current || loadedUrlRef.current !== url) return;
        handleFailureRef.current(
          e instanceof Error ? e.message : undefined,
          { url, channel: 'promise' },
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
      /** The expo-video player a VideoView binds — the engine's
          ONE video player (the quality pool is gone with the
          owner's no-switching ruling, 2026-11-11). Which surface
          binds it is per-mode: the watch hero's born-visible
          surface, or the listen hero's hidden one — never both
          at once, and the binding only moves while paused (the
          surface discipline — see notifySurfaceFirstFrame). */
      surfacePlayer,
      /** Surface discipline (2026-11-11 restructure): the
          visible surface's VideoView reports its first rendered
          frame here (onFirstFrameRender, visible=true) — that
          marks the surface ready for this player instance and
          releases any gate-held watch play/resume. The hidden
          listen surface passes visible=false: its frames never
          mark readiness. */
      notifySurfaceFirstFrame,
      /** Surface discipline: call as a surface unmounts (or
          before a mode switch swaps surfaces) — pauses the video
          player synchronously if a video candidate is live, so
          the player is NEVER playing while unbound. A watch
          resume afterwards waits for the new surface's first
          frame through the gate (held in the resume slot); a
          listen resume plays at once (the fallback is ungated). */
      surfaceDetach,
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
      /** Video frames for the CURRENT source are on screen
          (false before the first frame — the artwork-under-player
          window surfaces hold the poster for). */
      framesRendered,
      /** W2: watch degraded to the listen chain's audio (opt-in
          claims only) — render artwork + an audio-only note. */
      audioFallback,
      /** Buffer package: the detail Listen prepare download's
          progress for the claim in play (null unless a prepare
          is registered for it) — the listen hero renders the
          honest byte-% while the claim waits on the transfer. */
      prepareProgress,
      playerError,
      ended,
      isPlaying,
      seekToRatio,
      seekTo,
      toggleMain,
      retry,
    }),
    [
      playerHandle,
      surfacePlayer,
      notifySurfaceFirstFrame,
      surfaceDetach,
      kind,
      candidate,
      url,
      localUsable,
      offline,
      unavailable,
      buffering,
      framesRendered,
      audioFallback,
      prepareProgress,
      playerError,
      ended,
      isPlaying,
      seekToRatio,
      seekTo,
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
