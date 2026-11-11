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
import {
  useVideoPlayer,
  VideoView,
  type VideoPlayerStatus,
} from 'expo-video';
import { useEventListener } from 'expo';
import { Music2, Volume2, VolumeX } from 'lucide-react-native';
import { isPlausibleUrl } from '../playback';
import { isQuizSliceUri, prefetchQuizSlice } from '../quizPrefetch';
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
  createQuizStallTracker,
  firstCandidateIsVideo,
  pickPreloadCandidate,
  quizAudioPhase,
  quizFailedShouldClear,
  quizProgressSignature,
  quizQuestionStallShouldTrip,
  quizSampleStarted,
  quizStallObserve,
  quizVideoStatusAfterLoadIssued,
  tagCandidates,
  watchdogPollActive,
  watchdogShouldTrip,
  type QuizProgressSample,
  type QuizStallTracker,
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
 * Stall watchdog — two paths, selected by the absence of a hold
 * moment. The held (countdown) path keeps the original ~4s
 * watchdog, armed from the intended start moment (playAtMs),
 * never from the preload — time spent intentionally held does
 * not count (mediaEngine.watchdogShouldTrip). The SOLO path
 * (2026-11-11 fix v2 — field failures: healthy .oggs executed
 * at 4s on slow loads; then a dead-silent question outliving
 * its verdict-less 30s grace) judges CONTINUOUS NO-PROGRESS
 * against a PER-QUESTION budget instead: a progress value
 * sampled live from the player (duration / position / buffered)
 * re-stamps the question's silence clock, a candidate switch
 * does NOT (the silence accrues across the chain), 10s of
 * unbroken silence advances the chain / delivers the verdict,
 * and a progressing or started clip is never killed
 * (mediaEngine.quizStallObserve / quizQuestionStallShouldTrip).
 * On both paths a hard error still advances the chain
 * immediately.
 *
 * Resurrection (solo, v2): `failed` is not terminal. Nothing
 * pauses or unloads the last candidate's player when the
 * verdict lands — it keeps its play-intent — and the hook keeps
 * listening: if that player later genuinely starts (the video
 * fallback finally buffering through; a slow .ogg finally
 * loading), the latch clears and the question reports
 * 'playing' again (mediaEngine.quizFailedShouldClear). The
 * countdown path's verdict stays latched, exactly as before.
 *
 * Video-leg status discipline (clock-stall fix, 2026-11-12):
 * the audio leg's per-load status reset (fresh player + ref
 * stamp) is mirrored for video — a statusChange bridge feeds
 * `videoStatusRef`, and every video load STAMPS the ref to
 * 'loading' synchronously at issuance — so a question can
 * never inherit its predecessor's 'readyToPlay' and lose the
 * phase edge the solo clock starts on (the song playing while
 * the timer never started; diagnosis QUIZ-CLOCK-STALL-
 * DIAGNOSIS-2026-11-12). The stamp writes only 'loading': no
 * clock can start early off it, and the countdown path's
 * hold/watchdog semantics are untouched.
 *
 * `nextCandidates` + `nextMediaKey` (solo next-question preload,
 * playback plan; part 6 rework 2026-11-11): while the current
 * question plays, the NEXT question's first audio candidate is
 * prefetched as a partial-file SLICE into the prefetch cache
 * (src/quizPrefetch.ts) under the next mediaKey; when that
 * question starts, its chain leads with the local slice instead
 * of loading fresh. (The countdown path keeps the original
 * shared-slot preload + adoption, unchanged.) The current
 * question keeps playing throughout — the prefetch is a
 * background download, not a player.
 */
function useQuizMediaPlayer(
  candidates: (string | null)[],
  mediaKey: string,
  playAtMs?: number,
  nextCandidates?: (string | null)[],
  nextMediaKey?: string,
) {
  const sources = useMemo(
    () =>
      candidates.filter(
        (url): url is string =>
          url !== null && (isPlausibleUrl(url) || isQuizSliceUri(url)),
      ),
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
  /* Video status bridge (clock-stall fix, 2026-11-12 — mirrors
     the audio bridge below): the player is created ONCE for the
     hook's life and its status is purely event-fed, so the hook
     keeps the latest status in a ref fed by a statusChange
     listener (+ a tick to re-render), and the per-candidate
     load effect STAMPS the ref to 'loading' synchronously when
     a new load is issued (mediaEngine
     .quizVideoStatusAfterLoadIssued). Without the stamp, a
     question whose predecessor left the player at
     'readyToPlay' inherited that status across the switch:
     the phase never edged, QuizAudioOnly never reported
     'playing', and the solo clock (and the server's
     playback-start signal — the same consumer) never fired
     while the song audibly played (diagnosis
     QUIZ-CLOCK-STALL-DIAGNOSIS-2026-11-12). The watchdog poll
     also reads this ref, so its loading observation is the
     stamped truth, not a leftover from the previous question. */
  const videoStatusRef = useRef<VideoPlayerStatus>(videoPlayer.status);
  const [, setVideoTick] = useState(0);
  useEffect(() => {
    let subscription: { remove: () => void } | null = null;
    try {
      subscription = videoPlayer.addListener(
        'statusChange',
        ({ status: next }) => {
          videoStatusRef.current = next;
          setVideoTick((t) => t + 1);
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
  }, [videoPlayer]);

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
          // Resurrection (solo, v2): a late genuine start of the
          // candidate the chain sits on clears a 'failed'
          // verdict — a loaded status IS this hook's 'playing'
          // signal for audio (releaseHold has just commanded
          // play), so the question is playing again.
          if (
            quizFailedShouldClear({
              failed: failedRef.current,
              held: playAtRef.current !== undefined,
              currentKind: kindRef.current,
              signalKind: 'audio',
              started:
                status.isLoaded || status.playing || status.currentTime > 0,
            })
          ) {
            setFailed(false);
          }
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
  /* Ref mirrors the stall poll and the resurrection listeners
     read at event time: which candidate the chain sits on
     (mediaKey + url), and whether the verdict has latched. */
  const urlRef = useRef(url);
  urlRef.current = url;
  const mediaKeyRef = useRef(mediaKey);
  mediaKeyRef.current = mediaKey;
  const failedRef = useRef(failed);
  failedRef.current = failed;

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
    // The solo stall tracker is NOT reset here (v2): it belongs
    // to the QUESTION — its resets / re-baselines happen inside
    // the poll's observations, keyed by mediaKey + candidate,
    // so a candidate switch inside a question cannot restart
    // the silence clock.

    if (current.kind === 'audio') {
      ensureAudioMode();
      // Release the previous candidate's audio player.
      releaseAudioOwned();
      // Adopt a preload made for THIS mediaKey (the countdown
      // slot preload) — its bytes move with the player. Solo no
      // longer fills the slot (part 6 prefetches a file slice
      // instead, which leads the candidate chain), so for solo
      // this simply misses and the player loads the chain head.
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
    // STAMP (clock-stall fix, 2026-11-12): the player IS
    // loading from this moment by construction; stamping the
    // status ref synchronously — before the native player can
    // publish anything about the new source — guarantees the
    // buffering interlude whose end (the genuine readyToPlay
    // event, fed back through the bridge above) is the edge
    // the solo clock starts on, even when the previous
    // question left this player at 'readyToPlay'.
    videoStatusRef.current = quizVideoStatusAfterLoadIssued();
    setVideoTick((t) => t + 1);
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

  /* ---- video error → chain advance; late ready → resurrection ---- */
  useEventListener(videoPlayer, 'statusChange', ({ status: next }) => {
    if (next === 'readyToPlay') {
      // Resurrection (solo, v2): the candidate the chain sits on
      // reached readyToPlay AFTER the verdict — its load kept
      // its play-intent (the pending replace resolves into
      // releaseHold → play), so the question is playing again;
      // clear the latch. A no-op in every other state.
      if (
        quizFailedShouldClear({
          failed: failedRef.current,
          held: playAtRef.current !== undefined,
          currentKind: kindRef.current,
          signalKind: 'video',
          started: true,
        })
      ) {
        setFailed(false);
      }
      return;
    }
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
        : videoStatusRef.current;
  void audioPlayer;

  /* ---- stall watchdog ---- */
  // Two paths, selected by the absence of a hold moment:
  // - countdown (playAtMs set, multiplayer): the original
  //   watchdog — armed from the intended start, so the budget
  //   starts at playAtMs, never at the preload. UNCHANGED.
  // - solo (no playAtMs): the stall decision below.
  const loadStartedAtRef = useRef(0);
  /* Solo stall tracker (v2): the question-scoped silence memory
     — the chain's last progress signature / stamp / started
     latch — advanced ONLY through quizStallObserve in the poll
     below, so every transition follows the pure budget rules.
     The countdown path never reads it. */
  const stallTrackerRef = useRef<QuizStallTracker>(createQuizStallTracker());
  /** Sample the current candidate's progress VALUE live from its
      player, with its loading flag: audio reads the status
      bridge's latest AudioStatus (duration is its progress
      signal — expo-audio exposes no buffered position, so 0);
      video reads the player's own duration / position /
      bufferedPosition. Null only when the video player has been
      released mid-poll — nothing left to judge. */
  const sampleQuizProgress = (): {
    progress: QuizProgressSample;
    loading: boolean;
  } | null => {
    if (kindRef.current === 'audio') {
      const s = audioStatusRef.current;
      return {
        progress: {
          duration: s?.duration ?? 0,
          currentTime: s?.currentTime ?? 0,
          bufferedPosition: 0,
          playing: s?.playing ?? false,
        },
        loading: audioTickStatus(s) === 'loading',
      };
    }
    try {
      return {
        progress: {
          duration: videoPlayer.duration,
          currentTime: videoPlayer.currentTime,
          bufferedPosition: videoPlayer.bufferedPosition,
          playing: videoPlayer.playing,
        },
        loading: videoStatusRef.current === 'loading',
      };
    } catch {
      return null;
    }
  };
  const watchdogArmed = watchdogPollActive({
    active: url !== null,
    hasSource: url !== null,
    failed,
  });
  useEffect(() => {
    if (!watchdogArmed) return;
    const id = setInterval(() => {
      if (playAtRef.current === undefined) {
        // SOLO path (v2): judge the QUESTION's continuous
        // no-progress against its 10s budget, fed by the sampled
        // progress VALUE — never the load's age. The observation
        // advances the tracker (progress re-stamps the silence
        // clock; a candidate switch re-baselines the signature
        // only, so the silence accrues across the chain); the
        // pure decision then says whether the current candidate
        // has stalled out.
        const sample = sampleQuizProgress();
        if (!sample) return;
        const now = Date.now();
        const tracker = quizStallObserve(stallTrackerRef.current, {
          mediaKey: mediaKeyRef.current,
          candidateKey: `${mediaKeyRef.current}:${urlRef.current ?? ''}`,
          signature: quizProgressSignature(sample.progress),
          started: quizSampleStarted(sample.progress),
          now,
        });
        stallTrackerRef.current = tracker;
        if (
          quizQuestionStallShouldTrip({
            now,
            loading: sample.loading,
            lastProgressAt: tracker.lastProgressAt,
            hasStarted: tracker.started,
            hasSource: true,
            failed: false,
            disabled: false,
          })
        ) {
          advanceRef.current();
        }
        return;
      }
      // Countdown path: the original watchdog, exactly as before.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    if (playAtMs !== undefined) {
      // Countdown path (multiplayer): unchanged — the round's
      // .ogg loads into the shared slot during the countdown and
      // is adopted at the start moment. (Rooms do not pass
      // nextCandidates today, so this branch is inert there; it
      // guards the contract, not a live flow.)
      preloadAudio(nextMediaKey, nextAudioUrl);
      return;
    }
    // Solo path (part 6, 2026-11-11): prefetch a SLICE of the
    // next song into the prefetch cache instead of loading the
    // whole file into the slot — the next question's chain then
    // leads with the local slice (see quizPrefetch.ts). Both
    // reveals (part-5 early, feedback) arrive through these same
    // props; the prefetch dedupes by mediaKey + URL.
    prefetchQuizSlice(nextMediaKey, nextAudioUrl);
  }, [nextAudioUrl, nextMediaKey, playAtMs]);

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
 * Solo passes `nextCandidates`/`nextMediaKey` (playback plan;
 * part 6): a slice of the next question's .ogg prefetches while
 * this one plays, and the next question's chain leads with that
 * local slice — the solo clock still starts at ACTUAL playback
 * (the sliced clip reports 'playing' the moment it starts,
 * exactly like a fresh load that was fast).
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

  const phase: QuizAudioPhase = quizAudioPhase({
    failed,
    hasUrl: url !== null,
    holdPending,
    status,
  });

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
