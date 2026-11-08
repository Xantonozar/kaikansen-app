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
 *   watch = highest-resolution video source; listen = stored audio →
 *   the derived .ogg twin of the video file → the video file itself
 *   behind the artwork, advancing one candidate per player error.
 * - Offline first: a completed download for the entry+mode wins over
 *   the remote URL (the record is returned as `localUsable` so a
 *   consumer can render from its snapshot when the catalogue fetch
 *   failed).
 * - `active` gates loading: while false nothing is loaded or played.
 *   The detail screen keeps it false until the user presses
 *   Watch/Listen; flipping back to false pauses and unloads, so a
 *   slug change starts clean. The player route passes true.
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
}) {
  const { slug, detail, entry, mode, active } = args;
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

  // Listen fallback chain (playback.ts): stored audio → derived .ogg
  // → the video file behind the artwork. A local download, watch
  // mode and fixture details (whose stored audio always resolves)
  // stay on the single resolved URL; the chain only engages for
  // remote listen playback, advancing one step per player error.
  const listenCandidates = useMemo(
    () =>
      detail && mode === 'listen' ? resolveListenCandidates(detail, entry) : [],
    [detail, entry, mode],
  );
  const [candidateIndex, setCandidateIndex] = useState(0);
  // A different theme/entry/mode restarts the chain from the top.
  useEffect(() => {
    setCandidateIndex(0);
  }, [slug, mode, entry?.atEntryId]);

  const url = localUsable
    ? downloadFileUri(localUsable)
    : mode === 'listen' && detail
      ? (listenCandidates[candidateIndex] ?? null)
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

  // Load (or reload) the resolved source, then autoplay — starting
  // playback IS the play intent, same as the web's player. Inactive
  // consumers load nothing. Load failures surface through the
  // statusChange listener below, so the rejection is swallowed here.
  const loadedUrlRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);
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
      .catch(() => {});
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
    setPlayerError(null);
    setEnded(false);
    setProgress({ current: 0, duration: 0 });
  }, [active, player]);

  useEventListener(player, 'statusChange', ({ status: next, error }) => {
    if (next !== 'error') return;
    // Listen chain: a failed candidate hands over to the next one
    // instead of dying — only the LAST candidate's failure surfaces
    // as the error state.
    if (
      !localUsable &&
      mode === 'listen' &&
      candidateIndex + 1 < listenCandidates.length
    ) {
      setCandidateIndex(candidateIndex + 1);
      return;
    }
    setPlayerError(
      error?.message ??
        'This source could not be played. It may be unavailable or in a format this device cannot play.',
    );
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
    // Retry restarts the listen chain from its first candidate; the
    // index change alone reloads it, so only force the load when the
    // first candidate is already the one showing.
    if (
      !localUsable &&
      mode === 'listen' &&
      listenCandidates.length > 0 &&
      candidateIndex !== 0
    ) {
      setPlayerError(null);
      setCandidateIndex(0);
      return;
    }
    if (!url) return;
    setPlayerError(null);
    loadedUrlRef.current = null;
    void player
      .replaceAsync(url)
      .then(() => {
        if (mountedRef.current) player.play();
      })
      .catch(() => {});
  };

  return {
    player,
    url,
    localUsable,
    offline,
    unavailable,
    buffering,
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
