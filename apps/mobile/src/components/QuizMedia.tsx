import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  View,
  Text,
} from 'react-native';
import { AppImage } from './AppImage';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEvent, useEventListener } from 'expo';
import { Music2, Volume2, VolumeX } from 'lucide-react-native';
import { isPlausibleUrl } from '../playback';
import {
  adoptPreloadedPlayer,
  createAudioPlayer,
  ensureAudioMode,
  preloadAudio,
  releaseAudioPlayer,
  type AudioPlayer,
  type AudioStatus,
} from '../audioEngine';

/** Normalise an expo-audio status into the quiz engine's status
    vocabulary (the bridge listener keeps the latest in a ref). */
function audioTickStatus(
  status: AudioStatus | null,
): 'loading' | 'readyToPlay' | 'error' {
  if (!status) return 'loading';
  if (status.error) return 'error';
  return status.isLoaded ? 'readyToPlay' : 'loading';
}
import {
  WATCHDOG_POLL_INTERVAL_MS,
  firstCandidateIsVideo,
  pickPreloadCandidate,
  tagCandidates,
  watchdogPollActive,
  watchdogShouldTrip,
} from '../mediaEngine';
import { radii, spacing, typeStyles, withOpacity, type Theme } from '../theme';
import { useTheme } from '../theme-context';

/**
 * The quiz player core (Slice M4; playback plan rework 2026-11-10)
 * — tries the candidates in order and plays the first that loads,
 * falling through on error; the last failure sticks (`failed`).
 * Sound starts ON (guessing needs the audio) with a mute toggle;
 * a new `mediaKey` restarts from the first candidate and
 * autoplays; leaving the screen pauses the players (the hook
 * releases them on unmount), so no clip leaks over other screens.
 *
 * Engine routing (the playback plan): the candidate chain is
 * routed BY FILE TYPE within the chain — an audio file candidate
 * (the derived .ogg, a genuine stored audio file) plays through
 * expo-audio, adopted from the shared preload slot when a solo
 * next-question / countdown preload already loaded it; a video
 * file candidate plays through expo-video. Surface rule (the
 * untouchable hidden-video fallback): NO surface is EVER
 * rendered for an audio candidate — expo-audio has none — and a
 * video candidate in the audio contexts (QuizAudioOnly, and the
 * audioOnly card) renders only the 1×1 hidden surface. The
 * default (legacy watch) QuizMedia keeps its one exception: its
 * FIRST candidate on the visible surface, as before.
 *
 * `playAtMs` (multiplayer countdown, owner design 2026-11-10):
 * when given, a loaded source is HELD — loaded, not playing —
 * until that epoch-ms moment, so a room's pre-round countdown
 * can preload the audio and every client starts it at 0 together.
 * A moment already past plays immediately; `holdPending` reports
 * the held state so callers show "loading" until the start.
 * Playback-plan refinement: for an AUDIO-first round the hold is
 * now a true expo-audio PRELOAD (the round's .ogg loads into the
 * shared slot during the countdown; at the moment, the engine
 * player adopts it and plays — near-instant and sample-synced);
 * a round whose FIRST candidate is a video file keeps the
 * original expo-video hold exactly as before.
 *
 * Stall watchdog (~4s): a source stuck in `loading` advances the
 * chain exactly like a hard error. On the held (countdown) path
 * the watchdog arms from the intended start moment (playAtMs),
 * never from the preload — time spent intentionally held does
 * not count (mediaEngine.watchdogShouldTrip).
 *
 * `nextCandidates` + `nextMediaKey` (solo next-question preload,
 * playback plan): while the current question plays, the NEXT
 * question's first audio candidate preloads into the shared slot
 * under the next mediaKey; when that question starts, its player
 * adopts the preload instead of loading fresh. The current
 * question keeps playing throughout — the slot is a separate
 * player. Discarded automatically when the question changes or
 * the component unmounts.
 */
function useQuizMediaPlayer(
  candidates: (string | null)[],
  mediaKey: string,
  playAtMs?: number,
  nextCandidates?: (string | null)[],
  nextMediaKey?: string,
) {
  const sources = useMemo(
    () => candidates.filter(isPlausibleUrl),
    [candidates],
  );
  const tagged = useMemo(
    () => tagCandidates(sources, 'listen'),
    [sources],
  );
  const [sourceIndex, setSourceIndex] = useState(0);
  const [muted, setMuted] = useState(false);
  const [failed, setFailed] = useState(false);
  const [holdPending, setHoldPending] = useState(false);
  const playAtRef = useRef(playAtMs);
  playAtRef.current = playAtMs;
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A new question/round restarts from the first candidate.
  useEffect(() => {
    setSourceIndex(0);
    setFailed(false);
    setHoldPending(false);
  }, [mediaKey]);

  const current = tagged[sourceIndex] ?? null;
  const url = current?.url ?? null;
  const kind = current?.kind ?? 'video';

  const videoPlayer = useVideoPlayer(null, (p) => {
    p.loop = false;
  });
  const { status: videoStatus } = useEvent(videoPlayer, 'statusChange', {
    status: videoPlayer.status,
  });

  /* ---- audio engine state ---- */
  // The live audio player for the current candidate: a player
  // created for it (imperatively — a quiz question lives for
  // seconds), or one ADOPTED from the preload slot. The state
  // mirror exists so the status hook + mute effect track it.
  const [audioPlayer, setAudioPlayer] = useState<AudioPlayer | null>(null);
  const audioStatusRef = useRef<AudioStatus | null>(null);
  const [, setAudioTick] = useState(0);
  const audioOwnedRef = useRef<{
    player: AudioPlayer;
    adopted: boolean;
  } | null>(null);

  const advanceRef = useRef<() => void>(() => {});
  advanceRef.current = () => {
    if (sourceIndex + 1 < sources.length) {
      loadedRef.current = null;
      setSourceIndex(sourceIndex + 1);
    } else {
      setFailed(true);
    }
  };

  /* ---- status event bridge (audio) ---- */
  // useAudioPlayerStatus binds through useEvent, whose listener
  // is the first render's emitter — the per-candidate player
  // changes identity, so the engine ALSO reacts through this
  // ref-fed listener (registered per player): a status error
  // advances the chain; a loaded status releases the hold.
  useEffect(() => {
    if (!audioPlayer) return;
    let subscription: { remove: () => void } | null = null;
    try {
      subscription = audioPlayer.addListener(
        'playbackStatusUpdate',
        (status) => {
          audioStatusRef.current = status;
          setAudioTick((t) => t + 1);
          if (status.error) advanceRef.current();
          if (status.isLoaded) releaseHoldRef.current();
        },
      );
    } catch {
      // Listener unsupported — the watchdog still guards stalls.
    }
    return () => {
      try {
        subscription?.remove();
      } catch {
        // Already detached.
      }
    };
  }, [audioPlayer]);

  /* ---- the hold (multiplayer countdown) ---- */
  const holdReleasedRef = useRef(false);
  const releaseHold = useCallback(() => {
    if (holdReleasedRef.current) return;
    const target = playAtRef.current;
    const waitMs = target ? target - Date.now() : 0;
    if (waitMs > 0) {
      // Loaded but HELD for the shared start moment: play exactly
      // at playAtMs (the countdown preload pattern).
      if (holdTimerRef.current) return;
      setHoldPending(true);
      holdTimerRef.current = setTimeout(() => {
        holdTimerRef.current = null;
        holdReleasedRef.current = true;
        setHoldPending(false);
        playCurrentRef.current();
      }, waitMs);
      return;
    }
    holdReleasedRef.current = true;
    setHoldPending(false);
    playCurrentRef.current();
  }, []);
  const releaseHoldRef = useRef(releaseHold);
  releaseHoldRef.current = releaseHold;
  const playCurrentRef = useRef<() => void>(() => {});
  playCurrentRef.current = () => {
    try {
      if (kindRef.current === 'audio') {
        audioOwnedRef.current?.player.play();
      } else {
        videoPlayer.play();
      }
    } catch {
      // Player released — nothing to start.
    }
  };
  const kindRef = useRef(kind);
  kindRef.current = kind;

  const mountedRef = useRef(true);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /* ---- per-candidate load ---- */
  const loadedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!url || !current) return;
    const loadKey = `${mediaKey}:${url}`;
    if (loadedRef.current === loadKey) return;
    loadedRef.current = loadKey;
    holdReleasedRef.current = false;
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    loadStartedAtRef.current = Date.now();

    if (current.kind === 'audio') {
      ensureAudioMode();
      // Release the previous candidate's audio player.
      releaseAudioOwned();
      // Adopt a preload made for THIS mediaKey (the solo
      // next-question preload, or the countdown slot preload) —
      // its bytes move with the player.
      let player = adoptPreloadedPlayer(mediaKey, url);
      const adopted = player !== null;
      if (!player) {
        try {
          player = createAudioPlayer(null);
        } catch {
          advanceRef.current();
          return;
        }
      }
      audioOwnedRef.current = { player, adopted };
      setAudioPlayer(player);
      audioStatusRef.current = player.currentStatus;
      try {
        player.muted = mutedRef.current;
        if (!adopted) player.replace(url);
        else if (player.currentStatus.isLoaded) releaseHold();
        // An adopted-but-still-loading player releases its hold
        // from the status bridge when isLoaded lands.
      } catch {
        advanceRef.current();
      }
      return;
    }

    // Video candidate — the original expo-video load + hold.
    let cancelled = false;
    void videoPlayer
      .replaceAsync(url)
      .then(() => {
        if (!mountedRef.current || cancelled) return;
        releaseHold();
      })
      .catch(() => {
        // Load failures also surface via statusChange; nothing to do.
      });
    return () => {
      cancelled = true;
      if (holdTimerRef.current) {
        clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
      }
      if (mountedRef.current) setHoldPending(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, mediaKey, videoPlayer]);

  const releaseAudioOwned = () => {
    const owned = audioOwnedRef.current;
    audioOwnedRef.current = null;
    if (!owned) return;
    try {
      owned.player.pause();
    } catch {
      // Already released.
    }
    if (owned.adopted) {
      releaseAudioPlayer(owned.player);
    }
  };

  /* ---- video error → chain advance ---- */
  useEventListener(videoPlayer, 'statusChange', ({ status: next }) => {
    if (next !== 'error') return;
    if (kind !== 'video') return;
    advanceRef.current();
  });

  /* ---- derived status ---- */
  const status: 'idle' | 'loading' | 'readyToPlay' | 'error' = !url
    ? 'idle'
    : failed
      ? 'error'
      : kind === 'audio'
        ? audioTickStatus(audioStatusRef.current)
        : videoStatus;
  void audioPlayer;

  /* ---- stall watchdog ---- */
  // Armed from the intended start: with a countdown hold, the
  // budget starts at playAtMs; without one, at the load moment.
  const loadStartedAtRef = useRef(0);
  const watchdogArmed = watchdogPollActive({
    active: url !== null,
    hasSource: url !== null,
    failed,
  });
  useEffect(() => {
    if (!watchdogArmed) return;
    const id = setInterval(() => {
      if (
        watchdogShouldTrip({
          now: Date.now(),
          loadingSince: status === 'loading' ? loadStartedAtRef.current : null,
          armedFrom: playAtRef.current ?? loadStartedAtRef.current,
          hasSource: true,
          failed: false,
          disabled: false,
        })
      ) {
        advanceRef.current();
      }
    }, WATCHDOG_POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [watchdogArmed, status, url, mediaKey]);

  /* ---- solo next-question preload ---- */
  // While this question plays, preload the NEXT question's first
  // audio candidate under the next mediaKey. A video-first next
  // question preloads nothing (its video keeps the normal load).
  const nextAudioUrl = useMemo(() => {
    if (!nextCandidates || !nextMediaKey) return null;
    const plausible = nextCandidates.filter(isPlausibleUrl);
    const next = tagCandidates(plausible, 'listen');
    if (firstCandidateIsVideo(next)) return null;
    return pickPreloadCandidate(next)?.url ?? null;
  }, [nextCandidates, nextMediaKey]);
  useEffect(() => {
    if (!nextAudioUrl || !nextMediaKey) return;
    preloadAudio(nextMediaKey, nextAudioUrl);
  }, [nextAudioUrl, nextMediaKey]);

  /* ---- mute + teardown ---- */
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  const toggleMute = useCallback(() => {
    setMuted((m) => !m);
  }, []);

  useEffect(() => {
    try {
      videoPlayer.muted = muted;
    } catch {
      // Released.
    }
    const owned = audioOwnedRef.current?.player;
    if (owned) {
      try {
        owned.muted = muted;
      } catch {
        // Released.
      }
    }
  }, [muted, videoPlayer, audioPlayer]);

  // Stop sound the moment the screen is left; an ADOPTED player
  // is released back (its native handle is single-owner), while a
  // per-candidate created player is simply paused — the audible
  // contract is that nothing sounds over other screens.
  useEffect(() => {
    return () => {
      try {
        videoPlayer.pause();
      } catch {
        // Player already released — nothing to stop.
      }
      const owned = audioOwnedRef.current;
      try {
        owned?.player.pause();
      } catch {
        // Already released.
      }
      if (owned?.adopted) {
        releaseAudioPlayer(owned.player);
        audioOwnedRef.current = null;
      }
    };
  }, [videoPlayer]);

  return {
    videoPlayer,
    audioPlayer,
    kind,
    status,
    url,
    sourceIndex,
    failed,
    muted,
    toggleMute,
    holdPending,
  };
}

/**
 * Embedded quiz media (Slice M4) — the question's theme clip, played
 * inline on the quiz screens (the player screen's expo-video
 * patterns, shrunk to a card).
 *
 * Default mode (legacy): the first candidate renders on the visible
 * video surface (watch); when it fails, later candidates play
 * behind the cover artwork (listen) — a round stays answerable even
 * when every candidate fails, with the failure stated on the card
 * instead of swallowed. A mute toggle sits on the corner.
 *
 * `audioOnly` mode (owner ruling, 2026-11-09 — quiz questions are
 * AUDIO-ONLY: the visible video and even the cover art give the
 * anime away on sight): the visible surface and the cover are never
 * rendered. Callers pass audio candidates only, which play behind
 * a neutral tile (music-note glyph, "Playing..." state); failure
 * keeps the same honest note as the default mode.
 *
 * Playback plan (2026-11-10): an AUDIO candidate never renders a
 * surface in either mode (expo-audio has none); a VIDEO candidate
 * renders the hidden 1×1 surface in audioOnly, and in the default
 * mode keeps the visible-first-candidate behaviour.
 */
export function QuizMedia({
  candidates,
  coverImage,
  mediaKey,
  audioOnly = false,
}: {
  candidates: (string | null)[];
  coverImage: string | null;
  mediaKey: string;
  audioOnly?: boolean;
}) {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const {
    videoPlayer,
    kind,
    status,
    url,
    sourceIndex,
    failed,
    muted,
    toggleMute,
  } = useQuizMediaPlayer(candidates, mediaKey);

  const watchSurface =
    !audioOnly && kind === 'video' && sourceIndex === 0 && url !== null;
  const buffering = url !== null && !failed && status === 'loading';

  if (audioOnly) {
    return (
      <View style={styles.wrap}>
        <View style={styles.audioTile}>
          {buffering ? (
            <ActivityIndicator color={theme.accent} size="large" />
          ) : (
            <>
              <Music2 size={30} color={theme.muted} strokeWidth={1.8} />
              {!failed && url !== null && (
                <Text style={styles.audioTileText}>Playing...</Text>
              )}
            </>
          )}
        </View>
        {url !== null && kind === 'video' && (
          <VideoView
            player={videoPlayer}
            style={styles.hiddenSurface}
            nativeControls={false}
          />
        )}
        {url !== null && !failed && (
          <Pressable
            onPress={toggleMute}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel={muted ? 'Unmute theme' : 'Mute theme'}
            style={styles.muteButton}
          >
            {muted ? (
              <VolumeX size={17} color={theme.text} strokeWidth={2} />
            ) : (
              <Volume2 size={17} color={theme.text} strokeWidth={2} />
            )}
          </Pressable>
        )}
        {(failed || url === null) && (
          <View style={styles.noteBar}>
            <Text style={styles.note}>
              {url === null && !failed
                ? 'No playable media for this theme — you can still answer.'
                : 'This theme could not be played — you can still answer.'}
            </Text>
          </View>
        )}
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      {watchSurface ? (
        <VideoView
          player={videoPlayer}
          style={styles.video}
          contentFit="contain"
          nativeControls={false}
        />
      ) : (
        <>
          {coverImage ? (
            <AppImage source={coverImage} style={styles.artwork} />
          ) : (
            <View style={[styles.artwork, styles.artworkPlaceholder]} />
          )}
          {url !== null && kind === 'video' && (
            <VideoView
              player={videoPlayer}
              style={styles.hiddenSurface}
              nativeControls={false}
            />
          )}
        </>
      )}
      {buffering && (
        <View style={styles.overlayCenter}>
          <ActivityIndicator color={theme.accent} size="large" />
        </View>
      )}
      {url !== null && !failed && (
        <Pressable
          onPress={toggleMute}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={muted ? 'Unmute theme' : 'Mute theme'}
          style={styles.muteButton}
        >
          {muted ? (
            <VolumeX size={17} color={theme.text} strokeWidth={2} />
          ) : (
            <Volume2 size={17} color={theme.text} strokeWidth={2} />
          )}
        </Pressable>
      )}
      {(failed || url === null) && (
        <View style={styles.noteBar}>
          <Text style={styles.note}>
            {url === null && !failed
              ? 'No playable media for this theme — you can still answer.'
              : 'This theme could not be played — you can still answer.'}
          </Text>
        </View>
      )}
    </View>
  );
}

export type QuizAudioPhase = 'buffering' | 'playing' | 'failed' | 'empty';

export interface QuizAudioState {
  phase: QuizAudioPhase;
  muted: boolean;
  toggleMute: () => void;
}

/**
 * Headless quiz audio (owner ruling, 2026-11-09) — the solo
 * question screen's player: no surface, no artwork, nothing
 * visible at all; the hidden question clip plays while the screen
 * composes its own chrome (countdown ring, status line, mute
 * button) from the reported state. Playback state is reported via
 * `onStateChange` whenever the phase or mute changes.
 *
 * The multiplayer countdown passes `playAtMs` (the round's
 * startedAt): an audio-first round PRELOADS its .ogg through
 * expo-audio during the countdown and starts it at the moment;
 * a video-first round keeps the expo-video hold. Either way the
 * phase reports 'buffering' until the clip actually starts.
 *
 * Solo passes `nextCandidates`/`nextMediaKey` (playback plan):
 * the next question's .ogg preloads while this one plays, and
 * the next question adopts it — the solo clock still starts at
 * ACTUAL playback (the preloaded clip reports 'playing' the
 * moment it starts, exactly like a fresh load that was fast).
 */
export function QuizAudioOnly({
  candidates,
  mediaKey,
  onStateChange,
  playAtMs,
  nextCandidates,
  nextMediaKey,
}: {
  candidates: (string | null)[];
  mediaKey: string;
  onStateChange?: (state: QuizAudioState) => void;
  /** Multiplayer countdown: load now, start playing at this
   *  epoch-ms moment (the round's server startedAt). While held,
   *  the phase reports 'buffering' — the clip has not started. */
  playAtMs?: number;
  /** Solo next-question preload (playback plan): the NEXT
   *  question's candidates + its mediaKey, preloaded while the
   *  current question plays. */
  nextCandidates?: (string | null)[];
  nextMediaKey?: string;
}) {
  const { videoPlayer, kind, status, url, failed, muted, toggleMute, holdPending } =
    useQuizMediaPlayer(candidates, mediaKey, playAtMs, nextCandidates, nextMediaKey);

  const phase: QuizAudioPhase = failed
    ? 'failed'
    : url === null
      ? 'empty'
      : holdPending || status === 'loading' || status === 'idle'
        ? 'buffering'
        : 'playing';

  const reportRef = useRef(onStateChange);
  reportRef.current = onStateChange;
  useEffect(() => {
    reportRef.current?.({ phase, muted, toggleMute });
  }, [phase, muted, toggleMute]);

  // Surface rule: an audio candidate renders NOTHING (expo-audio
  // has no surface — the question stays surface-free); a video
  // candidate (the hidden-video last resort) keeps its 1×1
  // hidden surface, picture-hidden as always.
  if (url === null || kind === 'audio') return null;
  return (
    <VideoView
      player={videoPlayer}
      style={hiddenSurfaceStyle}
      nativeControls={false}
    />
  );
}

const hiddenSurfaceStyle = {
  position: 'absolute' as const,
  width: 1,
  height: 1,
  opacity: 0,
};

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    wrap: {
      position: 'relative',
      backgroundColor: theme.surface,
      borderRadius: radii.md,
      overflow: 'hidden',
    },
    video: {
      width: '100%',
      aspectRatio: 16 / 9,
      backgroundColor: '#000',
    },
    artwork: {
      width: '100%',
      aspectRatio: 16 / 9,
      backgroundColor: theme.surface,
    },
    artworkPlaceholder: {
      backgroundColor: theme.raised,
    },
    audioTile: {
      width: '100%',
      aspectRatio: 16 / 9,
      backgroundColor: theme.raised,
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
    },
    audioTileText: {
      ...typeStyles.bodySmall,
      color: theme.muted,
    },
    hiddenSurface: {
      position: 'absolute',
      width: 1,
      height: 1,
      opacity: 0,
    },
    overlayCenter: {
      ...StyleSheet.absoluteFill,
      alignItems: 'center',
      justifyContent: 'center',
    },
    muteButton: {
      position: 'absolute',
      top: spacing.sm,
      right: spacing.sm,
      width: 34,
      height: 34,
      borderRadius: radii.sm,
      backgroundColor: withOpacity(theme.background, 0.62),
      alignItems: 'center',
      justifyContent: 'center',
    },
    noteBar: {
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      backgroundColor: theme.surface,
    },
    note: {
      ...typeStyles.bodySmall,
      color: theme.muted,
      textAlign: 'center',
    },
  });
