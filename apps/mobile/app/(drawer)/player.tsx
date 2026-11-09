import { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  useFocusEffect,
  useLocalSearchParams,
  useRouter,
} from 'expo-router';
import { VideoView } from 'expo-video';
import {
  Download,
  Headphones,
  Maximize,
  Pause,
  Play,
  RotateCcw,
  SkipBack,
  SkipForward,
  X,
} from 'lucide-react-native';
import type { PlaybackMode } from '@kaikansen/contracts';
import { fixtureMode } from '../../src/api';
import { formatTime } from '../../src/playback';
import { usePlaybackSession } from '../../src/playback-context';
import {
  fontFamilies,
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
 * src/usePlayback.ts, owned by the ONE PlaybackProvider instance
 * (src/playback-context.tsx) and shared with the detail screen and
 * the mini player. This route is the presentation shell: header
 * (song/anime, Offline + mode chips), the video surface (watch) or
 * artwork with a hidden surface (listen), and custom icon-led
 * controls — play/pause (replay once ended), a tap-to-seek bar
 * with time labels, fullscreen (watch only) and close. Closing it
 * leaves the session playing under the mini player.
 *
 * On focus the route ADOPTS its params into the shared session —
 * but only when they identify a different track than the session's
 * current item, and only once per distinct param set: when the
 * session runs a queue (Slice 2.5), the queue may advance the
 * session well past the params this route was opened with, and
 * returning here must never clobber that queue — the route renders
 * whatever the session holds, so an advance while the route is
 * open is FOLLOWED (header, artwork and engine all move to the
 * now-playing theme), never hijacked back to the stale params.
 * When the session carries a queue, the mock's Up Next card
 * appears under the controls. The provider resolves the claimed
 * track's detail itself; this route no longer fetches.
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
  const paramMode: PlaybackMode =
    params.mode === 'listen' ? 'listen' : 'watch';
  const paramEntry =
    params.entry != null && params.entry !== '' ? Number(params.entry) : null;

  const {
    session,
    playback,
    resolution,
    hasNext,
    hasPrev,
    next,
    prev,
    nextQueueItem,
    startSession,
    updateSession,
  } = usePlaybackSession();

  /* Param adoption (see the header): a distinct param set is
     adopted at most once. When the params identify the session's
     current track — the normal case when a list screen claimed a
     queue and pushed this route, or the mini player reopened it —
     the session is left exactly as it is (only its mode/active
     flags are reconciled), so the queue survives. When they
     identify a different track, the route claims that track as a
     fresh single play and the provider resolves its detail. Once
     adopted, later session movement (queue advances, another
     screen's claim) is followed, never fought. The control row
     always carries prev/next flanking the main button — disabled
     at the queue bounds, and in single-track sessions (no queue),
     where both bounds are met at once. */
  const adoptedKeyRef = useRef<string | null>(null);
  const adoptParams = useCallback(() => {
    const key = `${params.slug}:${paramEntry ?? ''}:${paramMode}`;
    if (adoptedKeyRef.current === key) return;
    adoptedKeyRef.current = key;
    const currentEntryId =
      session.entry?.atEntryId ?? session.entryIdOverride ?? null;
    const sameTrack =
      session.slug === params.slug &&
      (paramEntry == null || paramEntry === currentEntryId);
    if (sameTrack) {
      if (session.mode !== paramMode || !session.active) {
        updateSession({ mode: paramMode, active: true });
      }
      return;
    }
    startSession({
      slug: params.slug,
      detail: null,
      entry: null,
      entryIdOverride: paramEntry,
      mode: paramMode,
      active: true,
    });
  }, [
    params.slug,
    paramEntry,
    paramMode,
    session.slug,
    session.entry,
    session.entryIdOverride,
    session.mode,
    session.active,
    startSession,
    updateSession,
  ]);
  useFocusEffect(adoptParams);

  /* Everything renders from the shared session: its detail (the
     provider resolves claimed tracks), its entry (for the header's
     version line) and its mode (a queue keeps its claimed mode
     across tracks, so the chips follow the session, not the
     possibly-stale params). */
  const detail = session.detail;
  const entry = session.entry;
  const mode = session.mode;
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
    const resolutionFailed =
      resolution !== null &&
      resolution.slug === session.slug &&
      (resolution.status === 'missing' || resolution.status === 'error');
    return (
      <View style={styles.screen}>
        <View style={[styles.topRow, { paddingTop: insets.top + spacing.sm }]}>
          {closeTile}
        </View>
        <View style={styles.center}>
          {resolutionFailed ? (
            <Text style={styles.message}>
              {resolution.status === 'missing'
                ? 'That theme could not be found.'
                : 'Could not load this theme.'}
            </Text>
          ) : (
            <ActivityIndicator color={theme.accent} />
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
                <View style={[styles.buttonSide, styles.buttonSideStart]}>
                  <Pressable
                    onPress={prev}
                    disabled={!hasPrev}
                    hitSlop={6}
                    accessibilityRole="button"
                    accessibilityLabel="Previous track"
                    accessibilityState={{ disabled: !hasPrev }}
                    style={({ pressed }) => [
                      styles.sideButton,
                      !hasPrev && styles.navDisabled,
                      pressed && styles.pressed,
                    ]}
                  >
                    <SkipBack size={24} color={theme.text} strokeWidth={2} />
                  </Pressable>
                </View>
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
                <View style={[styles.buttonSide, styles.buttonSideEnd]}>
                  <Pressable
                    onPress={next}
                    disabled={!hasNext}
                    hitSlop={6}
                    accessibilityRole="button"
                    accessibilityLabel="Next track"
                    accessibilityState={{ disabled: !hasNext }}
                    style={({ pressed }) => [
                      styles.sideButton,
                      !hasNext && styles.navDisabled,
                      pressed && styles.pressed,
                    ]}
                  >
                    <SkipForward
                      size={24}
                      color={theme.text}
                      strokeWidth={2}
                    />
                  </Pressable>
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

        {/* Up Next (the mock's card): the queue's next item, when
            there is one. Tapping it — or its play disc — skips to
            it, same as the Next control. */}
        {hasNext && nextQueueItem && (
          <Pressable
            onPress={next}
            accessibilityRole="button"
            accessibilityLabel={`Up next: ${nextQueueItem.title}. Play it next`}
            style={({ pressed }) => [
              styles.upNext,
              pressed && styles.pressed,
            ]}
          >
            {nextQueueItem.coverUrl ? (
              <Image
                source={{ uri: nextQueueItem.coverUrl }}
                style={styles.upNextCover}
              />
            ) : (
              <View
                style={[styles.upNextCover, styles.artworkPlaceholder]}
              />
            )}
            <View style={styles.upNextText}>
              <Text style={styles.upNextEyebrow}>UP NEXT</Text>
              <Text style={styles.upNextTitle} numberOfLines={1}>
                {nextQueueItem.title}
              </Text>
              <Text style={styles.upNextArtist} numberOfLines={1}>
                {nextQueueItem.artistLine}
              </Text>
            </View>
            <View style={styles.upNextDisc}>
              <Play size={16} color={theme.onAccent} strokeWidth={2} />
            </View>
          </Pressable>
        )}
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
    buttonSideStart: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'flex-start',
    },
    buttonSideEnd: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'flex-end',
    },
    navDisabled: {
      opacity: 0.3,
    },
    upNext: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      backgroundColor: theme.surface,
      borderRadius: radii.card,
      padding: spacing.md,
      marginHorizontal: spacing.screenEdge,
      marginTop: spacing.xl,
    },
    upNextCover: {
      width: 44,
      height: 44,
      borderRadius: radii.base,
      backgroundColor: theme.raised,
    },
    upNextText: {
      flex: 1,
    },
    upNextEyebrow: {
      ...typeStyles.caption,
      color: theme.secondary,
    },
    upNextTitle: {
      ...typeStyles.body,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.text,
      marginTop: 1,
    },
    upNextArtist: {
      ...typeStyles.bodySmall,
      color: theme.muted,
      marginTop: 1,
    },
    upNextDisc: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: theme.accent,
      alignItems: 'center',
      justifyContent: 'center',
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
