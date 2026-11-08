import { useEffect, useMemo, useRef, useState } from 'react';
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
import { VideoView } from 'expo-video';
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
import { fetchThemeBySlug, fixtureMode } from '../../src/api';
import { formatTime } from '../../src/playback';
import { usePlayback } from '../../src/usePlayback';
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
 * Player route (Slice M1) — full-screen Watch/Listen playback on
 * expo-video, opened from the Library (Offline rows) and playlist
 * screens with { slug, mode, entry (atEntryId) }. The theme detail
 * screen no longer comes here: it plays INLINE on the page, like
 * the website and the design (the hero card is the player).
 *
 * The playback engine itself — source resolution (highest-
 * resolution video for watch; the listen chain stored audio →
 * derived .ogg → the video file behind the artwork), offline-first
 * downloads, history recording, error/retry — lives in
 * src/usePlayback.ts and is shared with the detail screen. This
 * route is the presentation shell: header (song/anime, Offline +
 * mode chips), the video surface (watch) or artwork with a hidden
 * surface (listen), and custom icon-led controls — play/pause
 * (replay once ended), a tap-to-seek bar with time labels,
 * fullscreen (watch only) and close.
 *
 * A usable local download renders the player even when the
 * catalogue fetch failed (fully offline open from the Library):
 * header and artwork fall back to the download's stored snapshot.
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

  const playback = usePlayback({
    slug: params.slug,
    detail,
    entry,
    entryIdOverride:
      params.entry != null && params.entry !== ''
        ? Number(params.entry)
        : null,
    mode,
    active: true,
  });
  const {
    player,
    localUsable,
    offline,
    unavailable,
    buffering,
    playerError,
    ended,
    isPlaying,
    progress,
    fraction,
  } = playback;
  const videoRef = useRef<VideoView>(null);
  const [barWidth, setBarWidth] = useState(0);

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

  const onSeek = (locationX: number) => {
    if (barWidth <= 0) return;
    playback.seekToRatio(locationX / barWidth);
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
                onPress={playback.retry}
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
                  onPress={playback.toggleMain}
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
