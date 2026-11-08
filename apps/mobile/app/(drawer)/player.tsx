import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEvent, useEventListener } from 'expo';
import {
  Download,
  Headphones,
  Maximize,
  Pause,
  Play,
  RotateCcw,
  X,
} from 'lucide-react-native';
import type { PlaybackMode, ThemeDetail } from '@kaikansen/contracts';
import { fetchThemeBySlug, fixtureMode, recordWatch } from '../../src/api';
import { downloadFileUri, useDownloads } from '../../src/downloads';
import {
  formatTime,
  isPlausibleUrl,
  resolveListenCandidates,
  resolvePlaybackUrl,
} from '../../src/playback';
import {
  radii,
  spacing,
  typeStyles,
  withOpacity,
  type Theme,
} from '../../src/theme';
import { useTheme } from '../../src/theme-context';
import { CONTENT_MAX_WIDTH } from '../../src/layout';

/**
 * Player (Slice M1) — real Watch/Listen playback on expo-video.
 *
 * Opened from the theme detail screen with { slug, mode, entry
 * (atEntryId) }; the theme is re-fetched here so the detail screen
 * stays the only place that knows navigation, and this screen resolves
 * the playable URL from the fetched detail via src/playback.ts (the
 * web's per-entry choice: highest-resolution video source for watch,
 * the entry's audioUrl for listen, theme-level URLs as fallback).
 *
 * One player serves both modes: watch shows the video surface; listen
 * keeps the surface mounted but invisible and presents the artwork
 * instead (audio-only presentation, no video frame). Controls are
 * custom and icon-led: play/pause (replay once ended), a tap-to-seek
 * bar with time labels, fullscreen (watch only) and close.
 *
 * Listen source chain: most of the catalogue stores no audioUrl, so
 * listen resolves stored audio → the derived .ogg twin of the video
 * file (playback.ts mirrors the API's derivation) → the video file
 * itself behind the artwork, advancing one step per player error;
 * only when every candidate fails does the error state show. Audio
 * downloads resolve through the same playback.ts but stop at the
 * audio steps — a download never substitutes the video file.
 *
 * History: the first time playback genuinely starts (the player's
 * playing flag turns true) for a given entry+mode, POST
 * /library/history is fired once — recordWatch itself no-ops in
 * fixture mode and when signed out. Resumes and seeks never re-fire;
 * a different entry or mode is a new key and records again.
 *
 * Offline (Slice M3): a completed download for the opened entry+mode
 * (src/downloads.ts) wins over the remote URL — the local file plays
 * and an "Offline" chip shows in the header. The lookup keys off the
 * route's entry id, so when the catalogue fetch fails (no network)
 * the player still opens from the download's stored snapshot. History
 * is untouched by this: it records only when a detail entry resolved,
 * and offline its failure is swallowed exactly as before.
 *
 * Leaving the screen pauses the player (the hook releases it on
 * unmount), so no audio leaks over other screens. Background playback
 * and PiP are deliberately not enabled in this slice.
 */
export default function PlayerScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{
    slug: string;
    mode?: string;
    entry?: string;
  }>();
  const mode: PlaybackMode = params.mode === 'listen' ? 'listen' : 'watch';
  const downloads = useDownloads();

  const [detail, setDetail] = useState<ThemeDetail | null>(null);
  const [loadState, setLoadState] = useState<
    'loading' | 'ready' | 'missing' | 'error'
  >('loading');

  useEffect(() => {
    let live = true;
    setLoadState('loading');
    fetchThemeBySlug(params.slug)
      .then((data) => {
        if (!live) return;
        if (data) {
          setDetail(data);
          setLoadState('ready');
        } else {
          setLoadState('missing');
        }
      })
      .catch(() => {
        if (live) setLoadState('error');
      });
    return () => {
      live = false;
    };
  }, [params.slug]);

  const entry = useMemo(() => {
    if (!detail) return null;
    const wanted = Number(params.entry);
    return (
      detail.entries.find((e) => e.atEntryId === wanted) ??
      detail.entries[0] ??
      null
    );
  }, [detail, params.entry]);

  // Offline-first source (Slice M3): the route's entry id is the
  // lookup key when one was passed (detail screen and Library Offline
  // rows always pass it); otherwise the resolved entry's. A broken
  // record (file gone) is ignored — the remote URL stands.
  const wantedEntryId =
    params.entry != null && params.entry !== ''
      ? Number(params.entry)
      : entry?.atEntryId;
  const localRecord =
    wantedEntryId != null
      ? downloads.find(params.slug, wantedEntryId, mode)
      : undefined;
  const localUsable =
    localRecord && !localRecord.fileMissing ? localRecord : undefined;

  const rawUrl = detail ? resolvePlaybackUrl(detail, entry, mode) : null;
  const remoteUrl = isPlausibleUrl(rawUrl) ? rawUrl : null;

  // Listen fallback chain (playback.ts): stored audio → derived .ogg
  // → the video file behind the artwork. A local download, watch mode
  // and fixture details (whose stored audio always resolves) stay on
  // the single resolved URL; the chain only engages for remote listen
  // playback, advancing one step per player error (below).
  const listenCandidates = useMemo(
    () =>
      detail && mode === 'listen'
        ? resolveListenCandidates(detail, entry)
        : [],
    [detail, entry, mode],
  );
  const [candidateIndex, setCandidateIndex] = useState(0);
  // A different theme/entry/mode restarts the chain from the top.
  useEffect(() => {
    setCandidateIndex(0);
  }, [params.slug, mode, entry?.atEntryId]);

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
  const videoRef = useRef<VideoView>(null);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);
  const [progress, setProgress] = useState({ current: 0, duration: 0 });
  const [barWidth, setBarWidth] = useState(0);

  const { status } = useEvent(player, 'statusChange', {
    status: player.status,
  });
  const { isPlaying } = useEvent(player, 'playingChange', {
    isPlaying: player.playing,
  });

  // Load (or reload) the resolved source, then autoplay — opening the
  // player IS the play intent, same as the web's player page. Load
  // failures surface through the statusChange listener below, so the
  // promise rejection is swallowed here.
  const loadedUrlRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    if (!url || loadedUrlRef.current === url) return;
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
  }, [url, player]);

  useEventListener(player, 'statusChange', ({ status: next, error }) => {
    if (next !== 'error') return;
    // Listen chain: a failed candidate hands over to the next one
    // instead of dying — only the LAST candidate's failure surfaces
    // as the error state (QuizMedia's fall-through pattern).
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

  // Stop sound the moment the screen is left; the hook releases the
  // player itself on unmount.
  useEffect(() => {
    return () => {
      try {
        player.pause();
      } catch {
        // Player already released — nothing to stop.
      }
    };
  }, [player]);

  const closeTile = (
    <Pressable
      onPress={() => router.back()}
      hitSlop={3}
      accessibilityRole="button"
      accessibilityLabel="Close player"
      style={styles.closeHit}
    >
      <View style={styles.closeTileInner}>
        <X size={22} color={theme.text} strokeWidth={2} />
      </View>
    </Pressable>
  );

  // A usable local download renders the player even when the
  // catalogue fetch failed (fully offline open from the Library):
  // header and artwork fall back to the download's stored snapshot.
  if (!detail && !localUsable) {
    return (
      <View style={styles.screen}>
        <View style={[styles.topRow, { paddingTop: insets.top + spacing.sm }]}>
          {closeTile}
        </View>
        <View style={styles.center}>
          {loadState === 'loading' ? (
            <ActivityIndicator color={theme.accent} />
          ) : (
            <Text style={styles.message}>
              {loadState === 'missing'
                ? 'That theme could not be found.'
                : 'Could not load this theme.'}
            </Text>
          )}
        </View>
      </View>
    );
  }

  const cover = detail
    ? (detail.animeGrillImage ?? detail.animeCoverImage)
    : (localUsable?.coverImage ?? null);
  const headerSong = detail?.songTitle ?? localUsable?.songTitle ?? '';
  const headerMeta = detail
    ? `${detail.animeTitle}${entry ? ` · ${entry.version}` : ''}`
    : localUsable
      ? `${localUsable.animeTitle} · ${localUsable.version}`
      : '';
  const unavailable = url === null;
  const buffering = !unavailable && status === 'loading' && !playerError;
  const fraction =
    progress.duration > 0
      ? Math.min(1, Math.max(0, progress.current / progress.duration))
      : 0;

  const onSeek = (locationX: number) => {
    if (barWidth <= 0 || progress.duration <= 0) return;
    const ratio = Math.min(1, Math.max(0, locationX / barWidth));
    player.currentTime = ratio * progress.duration;
    setEnded(false);
  };

  const onMainButton = () => {
    if (ended) {
      player.replay();
      setEnded(false);
    } else if (isPlaying) {
      player.pause();
    } else {
      player.play();
    }
  };

  const onRetry = () => {
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

  return (
    <View style={styles.screen}>
      <View style={styles.column}>
        <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
          {closeTile}
          <View style={styles.headerText}>
            <Text style={styles.song} numberOfLines={1}>
              {headerSong}
            </Text>
            <Text style={styles.meta} numberOfLines={1}>
              {headerMeta}
            </Text>
          </View>
          {offline && (
            <View style={styles.modeChip}>
              <Download
                size={13}
                color={theme.onAccentContainer}
                strokeWidth={2}
              />
              <Text style={styles.modeChipText}>Offline</Text>
            </View>
          )}
          <View style={styles.modeChip}>
            {mode === 'listen' ? (
              <Headphones size={13} color={theme.onAccentContainer} strokeWidth={2} />
            ) : (
              <Play size={13} color={theme.onAccentContainer} strokeWidth={2} />
            )}
            <Text style={styles.modeChipText}>
              {mode === 'listen' ? 'Listen' : 'Watch'}
            </Text>
          </View>
        </View>

        <View style={styles.mediaWrap}>
          {mode === 'watch' ? (
            <VideoView
              ref={videoRef}
              player={player}
              style={styles.video}
              contentFit="contain"
              nativeControls={false}
            />
          ) : (
            <>
              {cover ? (
                <Image source={{ uri: cover }} style={styles.artwork} />
              ) : (
                <View style={[styles.artwork, styles.artworkPlaceholder]} />
              )}
              {/* Audio still plays through the player; the surface stays
                  mounted but invisible so listen mode has no video frame. */}
              <VideoView
                player={player}
                style={styles.hiddenSurface}
                nativeControls={false}
              />
            </>
          )}
          {buffering && (
            <View style={styles.overlayCenter}>
              <ActivityIndicator color={theme.accent} size="large" />
            </View>
          )}
        </View>

        <View style={styles.controls}>
          {unavailable ? (
            <Text style={styles.message}>
              {fixtureMode
                ? 'Playback is not available in demo mode for this theme.'
                : 'No playable source is available for this version.'}
            </Text>
          ) : playerError ? (
            <>
              <Text style={styles.message}>{playerError}</Text>
              <Pressable
                onPress={onRetry}
                accessibilityRole="button"
                accessibilityLabel="Try again"
                style={({ pressed }) => [
                  styles.retryButton,
                  pressed && styles.pressed,
                ]}
              >
                <RotateCcw size={17} color={theme.onAccent} strokeWidth={2} />
                <Text style={styles.retryText}>Try again</Text>
              </Pressable>
            </>
          ) : (
            <>
              <Pressable
                onLayout={(e) => setBarWidth(e.nativeEvent.layout.width)}
                onPress={(e) => onSeek(e.nativeEvent.locationX)}
                accessibilityRole="adjustable"
                accessibilityLabel="Seek"
                style={styles.seekHit}
              >
                <View style={styles.seekTrack}>
                  <View
                    style={[styles.seekFill, { width: `${fraction * 100}%` }]}
                  />
                  <View
                    style={[
                      styles.seekKnob,
                      { left: `${fraction * 100}%` },
                    ]}
                  />
                </View>
              </Pressable>
              <View style={styles.timeRow}>
                <Text style={styles.timeText}>
                  {formatTime(progress.current)}
                </Text>
                <Text style={styles.timeText}>
                  {formatTime(progress.duration)}
                </Text>
              </View>
              <View style={styles.buttonRow}>
                <View style={styles.buttonSide} />
                <Pressable
                  onPress={onMainButton}
                  accessibilityRole="button"
                  accessibilityLabel={
                    ended ? 'Replay' : isPlaying ? 'Pause' : 'Play'
                  }
                  style={({ pressed }) => [
                    styles.mainButton,
                    pressed && styles.pressed,
                  ]}
                >
                  {ended ? (
                    <RotateCcw size={26} color={theme.onAccent} strokeWidth={2} />
                  ) : isPlaying ? (
                    <Pause size={26} color={theme.onAccent} strokeWidth={2} />
                  ) : (
                    <Play size={26} color={theme.onAccent} strokeWidth={2} />
                  )}
                </Pressable>
                <View style={styles.buttonSide}>
                  {mode === 'watch' && (
                    <Pressable
                      onPress={() => {
                        void videoRef.current?.enterFullscreen();
                      }}
                      hitSlop={6}
                      accessibilityRole="button"
                      accessibilityLabel="Fullscreen"
                      style={styles.sideButton}
                    >
                      <Maximize size={20} color={theme.text} strokeWidth={2} />
                    </Pressable>
                  )}
                </View>
              </View>
            </>
          )}
        </View>
      </View>
    </View>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: theme.background,
    },
    column: {
      flex: 1,
      width: '100%',
      maxWidth: CONTENT_MAX_WIDTH,
      alignSelf: 'center',
    },
    topRow: {
      paddingHorizontal: spacing.screenEdge,
      paddingBottom: spacing.sm,
    },
    center: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: spacing.xxl,
    },
    message: {
      ...typeStyles.body,
      color: theme.muted,
      textAlign: 'center',
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.screenEdge,
      paddingBottom: spacing.md,
    },
    closeHit: {
      width: 44,
      height: 44,
      alignItems: 'center',
      justifyContent: 'center',
    },
    closeTileInner: {
      width: 38,
      height: 38,
      borderRadius: radii.base,
      backgroundColor: theme.raised,
      alignItems: 'center',
      justifyContent: 'center',
    },
    headerText: {
      flex: 1,
    },
    song: {
      ...typeStyles.sectionLabel,
      color: theme.text,
    },
    meta: {
      ...typeStyles.bodySmall,
      color: theme.muted,
      marginTop: 2,
    },
    modeChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      backgroundColor: withOpacity(theme.accent, 0.16),
      borderRadius: radii.pill,
      paddingHorizontal: spacing.sm + 2,
      paddingVertical: spacing.xs + 2,
    },
    modeChipText: {
      ...typeStyles.caption,
      color: theme.onAccentContainer,
    },
    mediaWrap: {
      position: 'relative',
      backgroundColor: theme.surface,
    },
    video: {
      width: '100%',
      aspectRatio: 16 / 9,
      backgroundColor: '#000',
    },
    artwork: {
      width: '100%',
      aspectRatio: 3 / 2,
      backgroundColor: theme.surface,
    },
    artworkPlaceholder: {
      backgroundColor: theme.raised,
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
    controls: {
      paddingHorizontal: spacing.screenEdge,
      paddingTop: spacing.xl,
      gap: spacing.md,
    },
    seekHit: {
      paddingVertical: spacing.sm,
    },
    seekTrack: {
      height: 4,
      borderRadius: 2,
      backgroundColor: theme.raised,
      justifyContent: 'center',
    },
    seekFill: {
      height: 4,
      borderRadius: 2,
      backgroundColor: theme.accent,
    },
    seekKnob: {
      position: 'absolute',
      width: 12,
      height: 12,
      borderRadius: 6,
      marginLeft: -6,
      backgroundColor: theme.accent,
    },
    timeRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
    },
    timeText: {
      ...typeStyles.mono,
      color: theme.muted,
    },
    buttonRow: {
      flexDirection: 'row',
      alignItems: 'center',
      marginTop: spacing.sm,
    },
    buttonSide: {
      flex: 1,
      alignItems: 'flex-end',
    },
    sideButton: {
      width: 44,
      height: 44,
      alignItems: 'center',
      justifyContent: 'center',
    },
    mainButton: {
      width: 64,
      height: 64,
      borderRadius: 32,
      backgroundColor: theme.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    retryButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      backgroundColor: theme.accent,
      borderRadius: 14,
      minHeight: 46,
      paddingHorizontal: spacing.lg,
      alignSelf: 'center',
    },
    retryText: {
      ...typeStyles.sectionLabel,
      color: theme.onAccent,
    },
    pressed: {
      opacity: 0.85,
    },
  });
