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
  Check,
  Download,
  Headphones,
  Maximize,
  Pause,
  Play,
  Repeat,
  Repeat1,
  RotateCcw,
  SkipBack,
  SkipForward,
  X,
} from 'lucide-react-native';
import type { PlaybackMode } from '@kaikansen/contracts';
import { fixtureMode } from '../../src/api';
import { downloadId, useDownloads } from '../../src/downloads';
import { entryHasAudio, formatTime } from '../../src/playback';
import { usePlaybackSession } from '../../src/playback-context';
import {
  fontFamilies,
  radii,
  spacing,
  typeStyles,
  type Theme,
} from '../../src/theme';
import { useTheme } from '../../src/theme-context';
import { CONTENT_MAX_WIDTH } from '../../src/layout';

/**
 * Player route — full-screen Watch/Listen playback on expo-video,
 * opened from the Library (Offline rows) and playlist screens with
 * { slug, mode, entry (atEntryId) }. The theme detail screen no
 * longer comes here: it plays INLINE on the page, like the website
 * and the design (the hero card is the player).
 *
 * Composition follows the Lavender Dusk player mock (design
 * polish pass): NO header bar — the media carries two dark-glass
 * discs (✕ top-left, maximize top-right, watch only) and the
 * OP/resolution chips at its bottom-left; below it a centred
 * title block (song, artist, "ANIME · SEASON YEAR" pill), the
 * Watch/Listen segmented toggle, the seek bar, and the transport
 * row: repeat · prev · pause disc · next · download. Repeat is
 * the provider's real repeat mode (off → queue → one, honoured
 * at track end — see src/playback-context.tsx); Download drives
 * the shared downloads store for the current theme + mode,
 * exactly like the detail screen's download sheet (tap again on
 * a downloaded track removes it; tap while downloading cancels).
 *
 * The playback engine itself — source resolution (highest-
 * resolution video for watch; the listen chain stored audio →
 * derived .ogg → the video file behind the artwork), offline-first
 * downloads, history recording, error/retry — lives in
 * src/usePlayback.ts, owned by the ONE PlaybackProvider instance
 * (src/playback-context.tsx) and shared with the detail screen and
 * the mini player.
 *
 * On focus the route ADOPTS its params into the shared session —
 * but only when they identify a different track than the session's
 * current item, and only once per distinct param set: when the
 * session runs a queue, the queue may advance the session well
 * past the params this route was opened with, and returning here
 * must never clobber that queue — the route renders whatever the
 * session holds, so an advance while the route is open is
 * FOLLOWED (media, title block and engine all move to the
 * now-playing theme), never hijacked back to the stale params.
 * When the session carries a queue, the mock's Up Next card
 * appears under the controls. The provider resolves the claimed
 * track's detail itself; this route no longer fetches.
 *
 * A usable local download renders the player even when the
 * catalogue fetch failed (fully offline open from the Library):
 * title block and artwork fall back to the download's stored
 * snapshot; the catalogue-only chips (type / resolution) and the
 * season pill simply don't render without a detail.
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
    repeatMode,
    cycleRepeat,
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
     screen's claim) is followed, never fought. */
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
     provider resolves claimed tracks), its entry (the chips and
     the download target) and its mode (a queue keeps its claimed
     mode across tracks, so the toggle follows the session, not
     the possibly-stale params). */
  const detail = session.detail;
  const entry = session.entry ?? detail?.entries[0] ?? null;
  const mode = session.mode;
  const {
    player,
    localUsable,
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

  /* Download state for the current theme + mode — the same store
     and the same states the detail screen's download sheet shows. */
  const downloads = useDownloads();
  const dlEntryId = entry?.atEntryId ?? session.entryIdOverride ?? null;
  const dlId =
    session.slug && dlEntryId != null
      ? downloadId(session.slug, dlEntryId, mode)
      : null;
  const dlRecord =
    session.slug && dlEntryId != null
      ? downloads.find(session.slug, dlEntryId, mode)
      : undefined;
  const dlProgress = dlId ? downloads.progressFor(dlId) : undefined;
  const dlError = dlId ? downloads.errorFor(dlId) : null;
  const dlDownloading = dlProgress !== undefined;
  const dlDownloaded = !!dlRecord && !dlRecord.fileMissing;

  const closeDisc = (
    <Pressable
      onPress={() => router.back()}
      hitSlop={3}
      accessibilityRole="button"
      accessibilityLabel="Close player"
      style={({ pressed }) => [styles.glassDisc, pressed && styles.pressed]}
    >
      <X size={20} color="#FFFFFF" strokeWidth={2} />
    </Pressable>
  );

  // A usable local download renders the player even when the
  // catalogue fetch failed (fully offline open from the Library):
  // title block and artwork fall back to the download's stored
  // snapshot.
  if (!detail && !localUsable) {
    const resolutionFailed =
      resolution !== null &&
      resolution.slug === session.slug &&
      (resolution.status === 'missing' || resolution.status === 'error');
    return (
      <View style={styles.screen}>
        <View style={[styles.topRow, { paddingTop: insets.top + spacing.sm }]}>
          {closeDisc}
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
  const titleSong = detail?.songTitle ?? localUsable?.songTitle ?? '';
  const titleArtist = detail
    ? detail.allArtists.length > 0
      ? detail.allArtists.join(' / ')
      : (detail.artistName ?? '')
    : (localUsable?.artistName ?? '');
  const seasonPill = detail
    ? detail.animeSeason && detail.animeSeasonYear
      ? `${detail.animeTitle} · ${detail.animeSeason} ${detail.animeSeasonYear}`
      : detail.animeTitle
    : null;
  /* The media chips: the theme's type + sequence, and (watch
     only) the top resolution the current entry streams at. */
  const maxResolution =
    mode === 'watch' && entry && entry.videoSources.length > 0
      ? Math.max(...entry.videoSources.map((v) => v.resolution))
      : null;
  const listenAvailable = detail
    ? entryHasAudio(detail, entry)
    : mode === 'listen';

  const onSeek = (locationX: number) => {
    if (barWidth <= 0) return;
    playback.seekToRatio(locationX / barWidth);
  };

  const onDownloadPress = () => {
    if (!dlId) return;
    if (dlDownloading) {
      void downloads.cancel(dlId);
    } else if (dlDownloaded) {
      void downloads.remove(dlId);
    } else if (detail && entry) {
      void downloads.start(detail, entry, mode);
    }
  };

  const RepeatIcon = repeatMode === 'one' ? Repeat1 : Repeat;
  const nextDisabled = !hasNext && repeatMode !== 'queue';

  return (
    <View style={styles.screen}>
      <View style={styles.column}>
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
              <ActivityIndicator color="#FFFFFF" size="large" />
            </View>
          )}
          {/* Overlaid media chrome (the mock): dark-glass discs,
              no header bar. */}
          <View
            style={[
              styles.mediaTopRow,
              { paddingTop: insets.top + spacing.sm },
            ]}
          >
            {closeDisc}
            {mode === 'watch' && (
              <Pressable
                onPress={() => {
                  void videoRef.current?.enterFullscreen();
                }}
                hitSlop={3}
                accessibilityRole="button"
                accessibilityLabel="Fullscreen"
                style={({ pressed }) => [
                  styles.glassDisc,
                  pressed && styles.pressed,
                ]}
              >
                <Maximize size={19} color="#FFFFFF" strokeWidth={2} />
              </Pressable>
            )}
          </View>
          {detail && (
            <View style={styles.mediaChips}>
              <View style={styles.mediaChip}>
                <Text style={styles.mediaChipText}>
                  {detail.type} {detail.sequence}
                </Text>
              </View>
              {maxResolution !== null && (
                <View style={styles.mediaChip}>
                  <View style={styles.resDot} />
                  <Text style={styles.mediaChipText}>
                    {maxResolution}p
                  </Text>
                </View>
              )}
            </View>
          )}
        </View>

        {/* Centred title block (the mock): song, artist, and the
            "ANIME · SEASON YEAR" pill. */}
        <View style={styles.titleBlock}>
          <Text style={styles.songTitle} numberOfLines={2}>
            {titleSong}
          </Text>
          {titleArtist ? (
            <Text style={styles.artistLine} numberOfLines={1}>
              {titleArtist}
            </Text>
          ) : null}
          {seasonPill ? (
            <View style={styles.seasonPill}>
              <Text style={styles.seasonPillText} numberOfLines={1}>
                {seasonPill}
              </Text>
            </View>
          ) : null}
        </View>

        {/* Watch/Listen toggle — the session's mode switch (the
            same segmented treatment as the detail page's). */}
        <View style={styles.modeToggle}>
          {(
            [
              { value: 'watch', label: 'Watch', Icon: Play },
              { value: 'listen', label: 'Listen', Icon: Headphones },
            ] as const
          ).map(({ value, label, Icon }) => {
            const active = mode === value;
            const disabled = value === 'listen' && !listenAvailable;
            return (
              <Pressable
                key={value}
                onPress={() => updateSession({ mode: value })}
                disabled={disabled}
                accessibilityRole="button"
                accessibilityLabel={label}
                accessibilityState={{ selected: active, disabled }}
                style={({ pressed }) => [
                  styles.modeSegment,
                  active && styles.modeSegmentActive,
                  disabled && styles.segmentDisabled,
                  pressed && styles.pressed,
                ]}
              >
                <Icon
                  size={15}
                  color={
                    disabled
                      ? theme.muted
                      : active
                        ? theme.onAccent
                        : theme.secondary
                  }
                  strokeWidth={2}
                />
                <Text
                  style={[
                    styles.modeSegmentText,
                    active && styles.modeSegmentTextActive,
                    disabled && { color: theme.muted },
                  ]}
                >
                  {label}
                </Text>
              </Pressable>
            );
          })}
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
              {/* Transport (the mock): repeat · prev · pause disc ·
                  next · download. */}
              <View style={styles.transport}>
                <Pressable
                  onPress={cycleRepeat}
                  hitSlop={6}
                  accessibilityRole="button"
                  accessibilityLabel={`Repeat: ${repeatMode}`}
                  style={({ pressed }) => [
                    styles.transportButton,
                    pressed && styles.pressed,
                  ]}
                >
                  <RepeatIcon
                    size={21}
                    color={
                      repeatMode === 'off' ? theme.muted : theme.accent
                    }
                    strokeWidth={2}
                  />
                </Pressable>
                <Pressable
                  onPress={prev}
                  disabled={!hasPrev}
                  hitSlop={6}
                  accessibilityRole="button"
                  accessibilityLabel="Previous track"
                  accessibilityState={{ disabled: !hasPrev }}
                  style={({ pressed }) => [
                    styles.transportButton,
                    !hasPrev && styles.navDisabled,
                    pressed && styles.pressed,
                  ]}
                >
                  <SkipBack size={25} color={theme.text} strokeWidth={2} />
                </Pressable>
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
                <Pressable
                  onPress={next}
                  disabled={nextDisabled}
                  hitSlop={6}
                  accessibilityRole="button"
                  accessibilityLabel="Next track"
                  accessibilityState={{ disabled: nextDisabled }}
                  style={({ pressed }) => [
                    styles.transportButton,
                    nextDisabled && styles.navDisabled,
                    pressed && styles.pressed,
                  ]}
                >
                  <SkipForward
                    size={25}
                    color={theme.text}
                    strokeWidth={2}
                  />
                </Pressable>
                <Pressable
                  onPress={onDownloadPress}
                  disabled={!dlId || (!dlDownloading && !dlDownloaded && !detail)}
                  hitSlop={6}
                  accessibilityRole="button"
                  accessibilityLabel={
                    dlDownloading
                      ? 'Cancel download'
                      : dlDownloaded
                        ? 'Downloaded — tap to remove'
                        : 'Download for offline playback'
                  }
                  accessibilityState={{
                    disabled:
                      !dlId ||
                      (!dlDownloading && !dlDownloaded && !detail),
                  }}
                  style={({ pressed }) => [
                    styles.transportButton,
                    !dlId && styles.navDisabled,
                    pressed && styles.pressed,
                  ]}
                >
                  {dlDownloading ? (
                    dlProgress !== null ? (
                      <Text style={styles.dlPercent}>
                        {Math.floor(dlProgress * 100)}%
                      </Text>
                    ) : (
                      <ActivityIndicator size="small" color={theme.accent} />
                    )
                  ) : dlDownloaded ? (
                    <Check size={22} color={theme.success} strokeWidth={2} />
                  ) : (
                    <Download
                      size={21}
                      color={detail ? theme.text : theme.muted}
                      strokeWidth={2}
                    />
                  )}
                </Pressable>
              </View>
              {dlError && !dlDownloading && (
                <Text style={styles.dlErrorText}>{dlError}</Text>
              )}
            </>
          )}
        </View>

        {/* Up Next (the mock's card): eyebrow + one line
            "title — artist" + lavender play disc. No cover
            thumbnail — the mock draws none. Tapping it — or its
            play disc — skips to it, same as the Next control. */}
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
            <View style={styles.upNextText}>
              <Text style={styles.upNextEyebrow}>Up next</Text>
              <Text style={styles.upNextLine} numberOfLines={1}>
                {nextQueueItem.title} — {nextQueueItem.artistLine}
              </Text>
            </View>
            <View style={styles.upNextDisc}>
              <Play size={16} color={theme.accent} strokeWidth={2} />
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
    mediaWrap: {
      position: 'relative',
      backgroundColor: '#000',
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
    mediaTopRow: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.screenEdge,
    },
    glassDisc: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: 'rgba(16, 7, 12, 0.45)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    mediaChips: {
      position: 'absolute',
      left: spacing.screenEdge,
      bottom: spacing.md,
      flexDirection: 'row',
      gap: spacing.sm,
    },
    mediaChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs + 2,
      backgroundColor: 'rgba(16, 7, 12, 0.55)',
      borderRadius: radii.pill,
      paddingHorizontal: spacing.sm + 2,
      paddingVertical: spacing.xs + 1,
    },
    mediaChipText: {
      ...typeStyles.caption,
      fontFamily: fontFamilies.bodyStrong,
      letterSpacing: 0.4,
      color: '#FFFFFF',
    },
    resDot: {
      width: 6,
      height: 6,
      borderRadius: 3,
      backgroundColor: '#FFFFFF',
    },
    titleBlock: {
      alignItems: 'center',
      paddingHorizontal: spacing.screenEdge,
      paddingTop: spacing.xl,
      gap: spacing.xs,
    },
    songTitle: {
      fontFamily: fontFamilies.display,
      fontSize: 20,
      color: theme.text,
      textAlign: 'center',
    },
    artistLine: {
      ...typeStyles.body,
      color: theme.secondary,
      textAlign: 'center',
    },
    seasonPill: {
      backgroundColor: theme.accentContainer,
      borderRadius: radii.pill,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs + 1,
      marginTop: spacing.xs,
      maxWidth: '100%',
    },
    seasonPillText: {
      ...typeStyles.caption,
      fontFamily: fontFamilies.bodyStrong,
      letterSpacing: 0.6,
      textTransform: 'uppercase',
      color: theme.onAccentContainer,
    },
    modeToggle: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 3,
      padding: 3,
      borderRadius: radii.pill,
      backgroundColor: theme.accentContainer,
      marginHorizontal: spacing.screenEdge,
      marginTop: spacing.lg,
    },
    modeSegment: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.xs + 2,
      paddingVertical: spacing.sm,
      borderRadius: radii.pill,
    },
    modeSegmentActive: {
      backgroundColor: theme.accent,
    },
    segmentDisabled: {
      opacity: 0.55,
    },
    modeSegmentText: {
      ...typeStyles.bodySmall,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.secondary,
    },
    modeSegmentTextActive: {
      ...typeStyles.bodySmall,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.onAccent,
    },
    controls: {
      paddingHorizontal: spacing.screenEdge,
      paddingTop: spacing.lg,
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
    transport: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.md,
      marginTop: spacing.xs,
    },
    transportButton: {
      width: 44,
      height: 44,
      alignItems: 'center',
      justifyContent: 'center',
    },
    navDisabled: {
      opacity: 0.3,
    },
    mainButton: {
      width: 64,
      height: 64,
      borderRadius: 32,
      backgroundColor: theme.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    dlPercent: {
      ...typeStyles.caption,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.accent,
    },
    dlErrorText: {
      ...typeStyles.caption,
      color: theme.accent,
      textAlign: 'center',
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
    upNextText: {
      flex: 1,
      gap: 2,
    },
    upNextEyebrow: {
      ...typeStyles.caption,
      fontFamily: fontFamilies.bodyStrong,
      letterSpacing: 0.6,
      textTransform: 'uppercase',
      color: theme.secondary,
    },
    upNextLine: {
      ...typeStyles.body,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.text,
    },
    upNextDisc: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: theme.accentContainer,
      alignItems: 'center',
      justifyContent: 'center',
    },
    pressed: {
      opacity: 0.85,
    },
  });
