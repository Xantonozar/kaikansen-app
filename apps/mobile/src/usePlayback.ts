import { useEffect, useMemo, useRef, useState } from 'react';
import { useVideoPlayer } from 'expo-video';
import { useEvent, useEventListener } from 'expo';
import type {
  PlaybackMode,
  ThemeDetail,
  ThemeEntry,
} from '@kaikansen/contracts';
import { recordWatch } from './api';
import { downloadFileUri, useDownloads, type DownloadRecord } from './downloads';
import {
  isPlausibleUrl,
  resolveListenCandidates,
  resolvePlaybackUrl,
  resolveWatchCandidates,
} from './playback';

/**
 * Playback engine (extracted from the player route, Slice M1) — one
 * expo-video player with the app's full source-resolution behaviour,
 * shared by the player route (Library / playlist opens) and the
 * theme detail screen's INLINE player (the website and the design
 * play on the theme page itself; the detail screen no longer
 * navigates away to play).
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
 * - Leaving/unmounting pauses the player (the hook releases it), so
 *   no audio leaks over other screens. Background playback and PiP
 *   stay deliberately off.
 */
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
}) {
  const { slug, detail, entry, mode, active } = args;
  const watchAudioFallback = args.watchAudioFallback === true;
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

  const player = useVideoPlayer(null, (p) => {
    p.timeUpdateEventInterval = 0.5;
    p.loop = false;
  });
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);
  const [progress, setProgress] = useState({ current: 0, duration: 0 });

  const { status } = useEvent(player, 'statusChange', {
    status: player.status,
  });
  const { isPlaying } = useEvent(player, 'playingChange', {
    isPlaying: player.playing,
  });

  const loadedUrlRef = useRef<string | null>(null);
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
  const handleFailure = (message?: string) => {
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

  // Load (or reload) the resolved source, then autoplay — starting
  // playback IS the play intent, same as the web's player. Inactive
  // consumers load nothing.
  useEffect(() => {
    if (!active || !url || loadedUrlRef.current === url) return;
    loadedUrlRef.current = url;
    setPlayerError(null);
    setEnded(false);
    setProgress({ current: 0, duration: 0 });
    void player
      .replaceAsync(url)
      .then(() => {
        if (mountedRef.current) player.play();
      })
      .catch((e: unknown) => {
        // A superseded load (a newer source already took over)
        // must not fail the source that replaced it.
        if (!mountedRef.current || loadedUrlRef.current !== url) return;
        handleFailure(e instanceof Error ? e.message : undefined);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, url, player]);

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
      player.pause();
    } catch {
      // Player already released — nothing to stop.
    }
    loadedUrlRef.current = null;
    failedUrlRef.current = null;
    setAudioFallback(false);
    setPlayerError(null);
    setEnded(false);
    setProgress({ current: 0, duration: 0 });
  }, [active, player]);

  useEventListener(player, 'statusChange', ({ status: next, error }) => {
    if (next !== 'error') return;
    // Chain: a failed candidate hands over to the next one instead
    // of dying — only the LAST candidate's failure surfaces as the
    // error state. One failure, one handling (see handleFailure).
    handleFailure(error?.message);
  });

  useEventListener(player, 'timeUpdate', ({ currentTime }) => {
    setProgress({ current: currentTime, duration: player.duration });
  });

  useEventListener(player, 'playToEnd', () => {
    setEnded(true);
  });

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
  // the player itself.
  useEffect(() => {
    return () => {
      try {
        player.pause();
      } catch {
        // Player already released — nothing to stop.
      }
    };
  }, [player]);

  const unavailable = url === null;
  const buffering = !unavailable && status === 'loading' && !playerError;
  const fraction =
    progress.duration > 0
      ? Math.min(1, Math.max(0, progress.current / progress.duration))
      : 0;

  /** Seek to a 0–1 fraction of the duration (tap-to-seek bar). */
  const seekToRatio = (ratio: number) => {
    if (progress.duration <= 0) return;
    player.currentTime =
      Math.min(1, Math.max(0, ratio)) * progress.duration;
    setEnded(false);
  };

  /** The main button: replay once ended, else play/pause. */
  const toggleMain = () => {
    if (ended) {
      player.replay();
      setEnded(false);
    } else if (isPlaying) {
      player.pause();
    } else {
      player.play();
    }
  };

  const retry = () => {
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
    loadedUrlRef.current = url;
    void player
      .replaceAsync(url)
      .then(() => {
        if (mountedRef.current) player.play();
      })
      .catch((e: unknown) => {
        if (!mountedRef.current) return;
        handleFailure(e instanceof Error ? e.message : undefined);
      });
  };

  return {
    player,
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
    progress,
    fraction,
    seekToRatio,
    toggleMain,
    retry,
  };
}
